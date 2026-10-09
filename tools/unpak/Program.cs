// Extracts files from a UE5 pak v11 (unencrypted, Oodle/none compression).
// usage: unpak <game.pak> <outDir> [substring-filter ...]
using System.Runtime.InteropServices;
using System.Text;

static class Oodle
{
    [DllImport("oo2core_9_win64.dll")]
    static extern long OodleLZ_Decompress(byte[] src, long srcLen, byte[] dst, long dstLen,
        int fuzz, int crc, int verbose, IntPtr dstBase, long dstBaseSize, IntPtr cb, IntPtr cbCtx, IntPtr scratch, long scratchSize, int threadPhase);

    public static byte[] Decompress(byte[] src, int rawLen)
    {
        var dst = new byte[rawLen];
        long n = OodleLZ_Decompress(src, src.Length, dst, rawLen, 1, 0, 0, IntPtr.Zero, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, 3);
        if (n != rawLen) throw new Exception($"Oodle failed ({n} != {rawLen})");
        return dst;
    }
}

record Entry(long Offset, long Size, long RawSize, int Method, uint BlockSize, List<(long Start, long End)> Blocks);

static class Program
{
    static string ReadFString(BinaryReader r)
    {
        int n = r.ReadInt32();
        if (n == 0) return "";
        if (n < 0) { var b = r.ReadBytes(-n * 2); return Encoding.Unicode.GetString(b, 0, b.Length - 2); }
        var a = r.ReadBytes(n); return Encoding.Latin1.GetString(a, 0, n - 1);
    }

    static Entry Decode(BinaryReader r)
    {
        uint v = r.ReadUInt32();
        uint blockSize = (v & 0x3f) == 0x3f ? r.ReadUInt32() : (v & 0x3f) << 11;
        int method = (int)((v >> 23) & 0x3f);
        long offset = (v & (1u << 31)) != 0 ? r.ReadUInt32() : r.ReadInt64();
        long raw = (v & (1u << 30)) != 0 ? r.ReadUInt32() : r.ReadInt64();
        long size = method != 0 ? ((v & (1u << 29)) != 0 ? r.ReadUInt32() : r.ReadInt64()) : raw;
        if ((v & (1u << 22)) != 0) throw new Exception("encrypted entries not supported");
        int blockCount = (int)((v >> 6) & 0xffff);
        var blocks = new List<(long, long)>();
        // offsets are relative to entry start; skip serialized FPakEntry header
        long cur = 8 + 8 + 8 + 4 + 20 + (method != 0 ? 4 + 16L * blockCount : 0) + 1 + 4;
        if (blockCount <= 1) blocks.Add((cur, cur + size));
        else for (int i = 0; i < blockCount; i++) { uint bs = r.ReadUInt32(); blocks.Add((cur, cur + bs)); cur += bs; }
        return new Entry(offset, size, raw, method, blockSize, blocks);
    }

    static int Main(string[] args)
    {
        if (args.Length < 2) { Console.WriteLine("usage: unpak <pak> <outDir> [filter...]"); return 1; }
        var filters = args.Skip(2).ToArray();
        using var fs = File.OpenRead(args[0]);
        var br = new BinaryReader(fs);
        fs.Seek(-221, SeekOrigin.End);
        var ft = br.ReadBytes(221);
        if (BitConverter.ToUInt32(ft, 17) != 0x5A6F12E1 || BitConverter.ToUInt32(ft, 21) != 11) throw new Exception("not a pak v11");
        long idxOff = BitConverter.ToInt64(ft, 25), idxSize = BitConverter.ToInt64(ft, 33);
        var methods = Enumerable.Range(0, 5).Select(i => Encoding.ASCII.GetString(ft, 61 + i * 32, 32).TrimEnd('\0')).ToArray();

        fs.Seek(idxOff, SeekOrigin.Begin);
        var ir = new BinaryReader(new MemoryStream(br.ReadBytes((int)idxSize)));
        ReadFString(ir); ir.ReadInt32(); ir.ReadUInt64();
        if (ir.ReadUInt32() != 0) ir.ReadBytes(8 + 8 + 20);
        long dirOff = 0, dirSize = 0;
        if (ir.ReadUInt32() != 0) { dirOff = ir.ReadInt64(); dirSize = ir.ReadInt64(); ir.ReadBytes(20); }
        var encoded = ir.ReadBytes(ir.ReadInt32());
        if (ir.ReadInt32() != 0) throw new Exception("non-encoded entries not supported");

        fs.Seek(dirOff, SeekOrigin.Begin);
        var dr = new BinaryReader(new MemoryStream(br.ReadBytes((int)dirSize)));
        int count = 0;
        for (int d = dr.ReadInt32(); d > 0; d--)
        {
            string dir = ReadFString(dr);
            for (int f = dr.ReadInt32(); f > 0; f--)
            {
                string path = dir.TrimStart('/') + ReadFString(dr);
                int loc = dr.ReadInt32();
                if (filters.Length > 0 && !filters.Any(x => path.Contains(x, StringComparison.OrdinalIgnoreCase))) continue;
                var e = Decode(new BinaryReader(new MemoryStream(encoded, loc, encoded.Length - loc)));
                var outPath = Path.Combine(args[1], path);
                Directory.CreateDirectory(Path.GetDirectoryName(outPath));
                using var o = File.Create(outPath);
                if (e.Method == 0)
                {
                    fs.Seek(e.Offset + e.Blocks.FirstOrDefault().Start, SeekOrigin.Begin);
                    o.Write(br.ReadBytes((int)e.RawSize));
                }
                else
                {
                    if (methods[e.Method - 1] != "Oodle") throw new Exception("unsupported compression " + methods[e.Method - 1]);
                    long left = e.RawSize;
                    foreach (var (s, en) in e.Blocks)
                    {
                        fs.Seek(e.Offset + s, SeekOrigin.Begin);
                        int raw = (int)(e.BlockSize == 0 ? left : Math.Min(e.BlockSize, left)); // single-block entries store blocksize 0
                        o.Write(Oodle.Decompress(br.ReadBytes((int)(en - s)), raw));
                        left -= raw;
                    }
                }
                count++;
            }
        }
        Console.WriteLine($"extracted {count} files");
        return 0;
    }
}
