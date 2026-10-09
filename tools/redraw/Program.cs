// Redraws text baked into UI textures: finds text lines and key icons on the original image,
// erases the text and typesets the translation in the game's font, keeping the icons.
// usage: redraw <spec.json> <srcDir> <outDir> <fontsDir>
//   spec: { "<asset>": { "font": "FuturaBookC", "bg": [x, y]?, "tracking": "auto"?,
//                        "lines": [ { "en": "Use {0} to scroll", "ru": "Используйте {0}, чтобы прокрутить" } ] } }
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

static class Program
{
    record Line(int Top, int Bottom, int Left, int Right, List<Rectangle> Icons, Rectangle Text, Color Ink);

    static int Main(string[] args)
    {
        if (args.Length < 4) { Console.Error.WriteLine("usage: redraw <spec.json> <srcDir> <outDir> <fontsDir>"); return 1; }
        var spec = JsonDocument.Parse(File.ReadAllText(args[0]), new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip });
        var families = new Dictionary<string, FontFamily>();
        int failed = 0;
        foreach (var asset in spec.RootElement.EnumerateObject())
        {
            try
            {
                var fontName = asset.Value.GetProperty("font").GetString();
                if (!families.ContainsKey(fontName))
                {
                    var fonts = new PrivateFontCollection(); // one per file: families from a shared collection can't be told apart
                    fonts.AddFontFile(Path.Combine(args[3], fontName + ".ufont"));
                    families[fontName] = fonts.Families[0];
                }
                Redraw(asset.Name, asset.Value, families[fontName], args[1], args[2]);
                Console.WriteLine($"ok   {asset.Name}");
            }
            catch (Exception e) { failed++; Console.Error.WriteLine($"FAIL {asset.Name}: {e.Message}"); }
        }
        return failed == 0 ? 0 : 2;
    }

    static void Redraw(string asset, JsonElement cfg, FontFamily family, string srcDir, string outDir)
    {
        using var src = new Bitmap(Path.Combine(srcDir, asset + ".png"));
        int w = src.Width, h = src.Height;
        var px = Pixels(src);
        var bgAt = cfg.TryGetProperty("bg", out var b) ? new Point(b[0].GetInt32(), b[1].GetInt32()) : new Point(8, h / 2);
        var bg = px[bgAt.Y * w + bgAt.X];
        var specLines = cfg.GetProperty("lines").EnumerateArray().ToList();
        bool tracking = cfg.TryGetProperty("tracking", out var tr) && tr.GetString() == "auto";

        // content mask inside a small margin (textures often have a 1px frame)
        const int margin = 4;
        var content = new bool[w * h];
        for (int y = margin; y < h - margin; y++)
            for (int x = margin; x < w - margin; x++)
                content[y * w + x] = Dist(px[y * w + x], bg) > 48;

        var lines = FindLines(content, px, w, h, specLines.Select(l => Placeholders(l.GetProperty("en").GetString())).ToList());
        if (lines.Count != specLines.Count)
            throw new Exception($"found {lines.Count} text lines, spec has {specLines.Count}: " + string.Join(", ", lines.Select(l => $"y{l.Top}-{l.Bottom}")));

        using var dst = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(dst);
        g.DrawImageUnscaled(src, 0, 0);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;

        for (int i = 0; i < lines.Count; i++)
        {
            var line = lines[i];
            string en = specLines[i].GetProperty("en").GetString(), ru = specLines[i].GetProperty("ru").GetString();

            // font size: render the English text and match its ink height to the original
            Layout(family, 100, en, line.Icons, tracking ? 0 : (float?)null, out var probeBox);
            float em = 100f * line.Text.Height / probeBox.Height;
            float originY = line.Text.Top - probeBox.Top * em / 100f;
            float? track = null;
            if (tracking)
            {
                Layout(family, em, en, line.Icons, 0, out var noTrack);
                int glyphs = Regex.Replace(en, @"\{\d+\}", "").Length;
                track = (line.Text.Width - noTrack.Width) / Math.Max(1, glyphs - 1);
            }

            // shrink long translations to fit the texture
            int maxWidth = w - 2 * Math.Max(margin, (int)(w * 0.04));
            var parts = Layout(family, em, ru, line.Icons, track, out var box);
            if (box.Width > maxWidth) { em *= maxWidth / box.Width; parts = Layout(family, em, ru, line.Icons, track, out box); }

            using (var clear = new SolidBrush(Color.FromArgb(bg)))
            {
                g.CompositingMode = CompositingMode.SourceCopy;
                g.FillRectangle(clear, Rectangle.FromLTRB(line.Left - 3, line.Top - 3, line.Right + 4, line.Bottom + 4));
                g.CompositingMode = CompositingMode.SourceOver;
            }
            float dx = (w - box.Width) / 2f - box.Left;
            using var ink = new SolidBrush(line.Ink);
            foreach (var part in parts)
            {
                if (part.Icon is Rectangle ic)
                    g.DrawImage(src, new Rectangle((int)Math.Round(part.X + dx), ic.Top, ic.Width, ic.Height), ic, GraphicsUnit.Pixel);
                else
                {
                    using var m = new Matrix();
                    m.Translate(dx, originY);
                    part.Path.Transform(m);
                    g.FillPath(ink, part.Path);
                }
            }
        }
        var outPath = Path.Combine(outDir, asset + ".png");
        Directory.CreateDirectory(Path.GetDirectoryName(outPath));
        dst.Save(outPath, ImageFormat.Png);
    }

    record Part(float X, GraphicsPath Path, Rectangle? Icon);

    // lays out "text {0} text" at origin (0,0); returns ink bounds (text and icons, x only for icons)
    static List<Part> Layout(FontFamily family, float em, string text, List<Rectangle> icons, float? tracking, out RectangleF box)
    {
        var parts = new List<Part>();
        float x = 0, top = float.MaxValue, bottom = float.MinValue, left = float.MaxValue, right = float.MinValue;
        using var font = new Font(family, em, GraphicsUnit.Pixel);
        using var measure = Graphics.FromImage(new Bitmap(1, 1));
        var fmt = (StringFormat)StringFormat.GenericTypographic.Clone();
        fmt.FormatFlags |= StringFormatFlags.MeasureTrailingSpaces;
        foreach (var token in Regex.Split(text, @"(\{\d+\})").Where(t => t.Length > 0))
        {
            var m = Regex.Match(token, @"^\{(\d+)\}$");
            if (m.Success)
            {
                var ic = icons[int.Parse(m.Groups[1].Value)];
                parts.Add(new Part(x, null, ic));
                left = Math.Min(left, x); right = Math.Max(right, x + ic.Width);
                x += ic.Width;
                continue;
            }
            // tracking draws glyph by glyph; otherwise the whole run keeps the font's kerning
            var runs = tracking.HasValue ? token.Select(c => c.ToString()).ToList() : new List<string> { token };
            foreach (var run in runs)
            {
                var path = new GraphicsPath();
                path.AddString(run, family, (int)FontStyle.Regular, em, new PointF(x, 0), fmt);
                var pb = path.GetBounds();
                if (pb.Width > 0)
                {
                    top = Math.Min(top, pb.Top); bottom = Math.Max(bottom, pb.Bottom);
                    left = Math.Min(left, pb.Left); right = Math.Max(right, pb.Right);
                    parts.Add(new Part(x, path, null));
                }
                x += measure.MeasureString(run, font, PointF.Empty, fmt).Width + (tracking ?? 0);
            }
        }
        box = RectangleF.FromLTRB(left, top, right, bottom);
        return parts;
    }

    static List<Line> FindLines(bool[] content, int[] px, int w, int h, List<int> iconCounts)
    {
        var rows = Enumerable.Range(0, h).Where(y => Enumerable.Range(0, w).Any(x => content[y * w + x])).ToList();
        var groups = new List<(int Top, int Bottom)>();
        foreach (var y in rows)
            if (groups.Count > 0 && y - groups[^1].Bottom <= 4) groups[^1] = (groups[^1].Top, y);
            else groups.Add((y, y));

        var lines = new List<Line>();
        for (int li = 0; li < groups.Count; li++)
        {
            var (top, bottom) = groups[li];
            var comps = Components(content, w, top, bottom);
            int wantIcons = li < iconCounts.Count ? iconCounts[li] : 0;
            var icons = new List<Rectangle>();
            if (wantIcons > 0)
            {
                foreach (var c in comps.Where(c => c.Gold >= 15).OrderBy(c => c.Box.Left))
                {
                    int k = icons.FindIndex(r => r.Left <= c.Box.Right + 2 && c.Box.Left <= r.Right + 2);
                    if (k >= 0) icons[k] = Rectangle.Union(icons[k], c.Box); else icons.Add(c.Box);
                }
                // parts enclosed by an icon (glyphs drawn inside key caps) belong to it
                foreach (var c in comps)
                {
                    int k = icons.FindIndex(r => Rectangle.Inflate(r, 3, 3).Contains(c.Box));
                    if (k >= 0) icons[k] = Rectangle.Union(icons[k], c.Box);
                }
                icons = icons.Select(r => new Rectangle(r.X, r.Y, r.Width + 1, r.Height + 1)).OrderBy(r => r.Left).ToList();
                if (icons.Count != wantIcons) throw new Exception($"line {li + 1}: expected {wantIcons} icons, found {icons.Count}");
            }
            int tTop = int.MaxValue, tBottom = int.MinValue, tLeft = int.MaxValue, tRight = int.MinValue, inkPx = 0, best = -1;
            int lLeft = int.MaxValue, lRight = int.MinValue;
            foreach (var c in comps)
            {
                lLeft = Math.Min(lLeft, c.Box.Left); lRight = Math.Max(lRight, c.Box.Right);
                if (icons.Any(r => r.IntersectsWith(c.Box))) continue;
                tTop = Math.Min(tTop, c.Box.Top); tBottom = Math.Max(tBottom, c.Box.Bottom);
                tLeft = Math.Min(tLeft, c.Box.Left); tRight = Math.Max(tRight, c.Box.Right);
                if (c.Strongest > best) { best = c.Strongest; inkPx = c.StrongestPx; }
            }
            if (tTop == int.MaxValue) throw new Exception($"line {li + 1}: no text pixels");
            lines.Add(new Line(top, bottom, lLeft, lRight, icons, Rectangle.FromLTRB(tLeft, tTop, tRight + 1, tBottom + 1), Color.FromArgb(px[inkPx])));
        }
        return lines;

        List<(Rectangle Box, int Gold, int Strongest, int StrongestPx)> Components(bool[] mask, int width, int y0, int y1)
        {
            var seen = new bool[mask.Length];
            var result = new List<(Rectangle, int, int, int)>();
            for (int y = y0; y <= y1; y++)
                for (int x = 0; x < width; x++)
                {
                    int i = y * width + x;
                    if (!mask[i] || seen[i]) continue;
                    var stack = new Stack<int>(); stack.Push(i); seen[i] = true;
                    int l = x, r = x, t = y, bt = y, gold = 0, strongest = -1, strongestPx = i;
                    while (stack.Count > 0)
                    {
                        int p = stack.Pop(), py = p / width, pxx = p % width;
                        l = Math.Min(l, pxx); r = Math.Max(r, pxx); t = Math.Min(t, py); bt = Math.Max(bt, py);
                        var c = Color.FromArgb(px[p]);
                        if (c.A > 200 && c.R > 170 && c.G > 110 && c.B < 140 && c.R - c.B > 80) gold++;
                        int d = Dist(px[p], px[(y0 + y1) / 2 * width + 4]);
                        if (d > strongest) { strongest = d; strongestPx = p; }
                        for (int dy = -1; dy <= 1; dy++)
                            for (int dx = -1; dx <= 1; dx++)
                            {
                                int ny = py + dy, nx = pxx + dx;
                                if (ny < y0 || ny > y1 || nx < 0 || nx >= width) continue;
                                int n = ny * width + nx;
                                if (mask[n] && !seen[n]) { seen[n] = true; stack.Push(n); }
                            }
                    }
                    result.Add((Rectangle.FromLTRB(l, t, r, bt), gold, strongest, strongestPx));
                }
            return result;
        }
    }

    static int Placeholders(string s) => Regex.Matches(s, @"\{\d+\}").Count;

    static int Dist(int a, int b)
    {
        Color x = Color.FromArgb(a), y = Color.FromArgb(b);
        return Math.Abs(x.R - y.R) + Math.Abs(x.G - y.G) + Math.Abs(x.B - y.B) + Math.Abs(x.A - y.A);
    }

    static int[] Pixels(Bitmap bmp)
    {
        var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        var px = new int[bmp.Width * bmp.Height];
        System.Runtime.InteropServices.Marshal.Copy(data.Scan0, px, 0, px.Length);
        bmp.UnlockBits(data);
        return px;
    }
}
