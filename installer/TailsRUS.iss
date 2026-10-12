; Inno Setup script: installs TailsRUS_P.pak into the game's Paks folder.
; Build: npm run installer   (passes /DAppVersion=... and the path of the built pak)
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef PakFile
  #define PakFile "..\build\TailsRUS_P.pak"
#endif
#define SteamAppId "2020030"
#define GameCheck "BackboneStories\Content\Paks"

[Setup]
AppId={{6D1B8C52-7A44-4C0E-9F1B-3E8B7C2A5D10}
AppName=Русификатор: Tails Noir Preludes - Енотий Перевод
AppVersion={#AppVersion}
AppPublisher=Dellyare
AppPublisherURL=https://github.com/Dellyare/tails-noir-preludes-rus
AppSupportURL=https://github.com/Dellyare/tails-noir-preludes-rus/issues
AppUpdatesURL=https://github.com/Dellyare/tails-noir-preludes-rus/releases
VersionInfoVersion={#AppVersion}
DefaultDirName={code:DefaultGameDir}
AppendDefaultDirName=no
DirExistsWarning=no
UsePreviousAppDir=yes
DisableProgramGroupPage=yes
DisableReadyPage=no
#ifdef Unelevated
PrivilegesRequired=lowest
#else
PrivilegesRequired=admin
#endif
; the uninstaller must not sit in the game folder
#ifdef Unelevated
UninstallFilesDir={localappdata}\TailsRUS
#else
UninstallFilesDir={commonappdata}\TailsRUS
#endif
UninstallDisplayName=Русификатор: Tails Noir Preludes - Енотий Перевод
SetupIconFile=icon.ico
DisableWelcomePage=no
InfoBeforeFile=info.txt
WizardImageFile=wizard-164.bmp,wizard-246.bmp,wizard-328.bmp
WizardSmallImageFile=wizard-small-55.bmp,wizard-small-83.bmp,wizard-small-110.bmp
UninstallDisplayIcon={uninstallexe}
OutputDir=..\build
OutputBaseFilename=TailsRUS_Setup_{#AppVersion}
Compression=lzma2/ultra
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[CustomMessages]
russian.GameNotFound=В выбранной папке не найдена игра: нет папки %1.%nУкажите папку, где установлена Tails Noir: Preludes (в Steam: «Управление» → «Просмотреть локальные файлы»).

[Messages]
russian.WelcomeLabel2=Мастер установит русский перевод игры Tails Noir: Preludes.%nВерсия {#AppVersion}, дата сборки {#GetDateTimeString('dd.mm.yyyy', '.', ':')}.%n%nНужна оригинальная игра. В её папку добавится один файл TailsRUS_P.pak, оригинальные файлы не изменяются. Удалить перевод можно через «Приложения» в параметрах Windows.%n%nВнимание: значительная часть перевода выполнена нейросетью и ещё не вычитана.
russian.FinishedLabelNoIcons=Русификатор установлен. Запустите игру: перевод подхватится автоматически.%n%nИллюстрация: Telegram @kaion_art
russian.SelectDirLabel3=Мастер установит русификатор в папку игры.
russian.SelectDirBrowseLabel=Выберите папку игры Tails Noir: Preludes (в ней должна лежать папка BackboneStories).

[Files]
Source: "{#PakFile}"; DestDir: "{app}\BackboneStories\Content\Paks"; DestName: "TailsRUS_P.pak"; Flags: ignoreversion

[Code]
// ---- finding the game --------------------------------------------------------------

function GameFolderOk(const Dir: String): Boolean;
begin
  Result := (Dir <> '') and DirExists(AddBackslash(Dir) + '{#GameCheck}');
end;

// text value after a quoted key in Valve's .vdf/.acf: "key"    "value"
function VdfValue(const Line, Key: String): String;
var
  P: Integer;
  Rest: String;
begin
  Result := '';
  P := Pos('"' + Key + '"', Line);
  if P = 0 then Exit;
  Rest := Copy(Line, P + Length(Key) + 2, MaxInt);
  P := Pos('"', Rest);
  if P = 0 then Exit;
  Rest := Copy(Rest, P + 1, MaxInt);
  P := Pos('"', Rest);
  if P = 0 then Exit;
  Result := Copy(Rest, 1, P - 1);
  StringChangeEx(Result, '\\', '\', True);
end;

function SteamLibraryGame(const Library: String): String;
var
  Lines: TArrayOfString;
  I: Integer;
  Manifest, InstallDir: String;
begin
  Result := '';
  Manifest := AddBackslash(Library) + 'steamapps\appmanifest_{#SteamAppId}.acf';
  if not LoadStringsFromFile(Manifest, Lines) then Exit;
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    InstallDir := VdfValue(Lines[I], 'installdir');
    if InstallDir <> '' then
    begin
      Result := AddBackslash(Library) + 'steamapps\common\' + InstallDir;
      Exit;
    end;
  end;
end;

function FindSteamGame: String;
var
  Steam, Candidate, Path: String;
  Lines: TArrayOfString;
  I: Integer;
begin
  Result := '';
  if not RegQueryStringValue(HKLM32, 'SOFTWARE\Valve\Steam', 'InstallPath', Steam) then
    if not RegQueryStringValue(HKCU, 'Software\Valve\Steam', 'SteamPath', Steam) then Exit;
  StringChangeEx(Steam, '/', '\', True);
  Candidate := SteamLibraryGame(Steam);
  if GameFolderOk(Candidate) then begin Result := Candidate; Exit; end;
  // other libraries listed in libraryfolders.vdf
  if LoadStringsFromFile(AddBackslash(Steam) + 'steamapps\libraryfolders.vdf', Lines) then
    for I := 0 to GetArrayLength(Lines) - 1 do
    begin
      Path := VdfValue(Lines[I], 'path');
      if Path = '' then Continue;
      Candidate := SteamLibraryGame(Path);
      if GameFolderOk(Candidate) then begin Result := Candidate; Exit; end;
    end;
end;

function FindEpicGame: String;
var
  Dir, Candidate: String;
  Find: TFindRec;
  Lines: TArrayOfString;
  I: Integer;
  Text: String;
begin
  Result := '';
  Dir := ExpandConstant('{commonappdata}\Epic\EpicGamesLauncher\Data\Manifests\');
  if not FindFirst(Dir + '*.item', Find) then Exit;
  try
    repeat
      if not LoadStringsFromFile(Dir + Find.Name, Lines) then Continue;
      Text := '';
      for I := 0 to GetArrayLength(Lines) - 1 do Text := Text + Lines[I];
      if Pos('BackboneStories', Text) = 0 then Continue;
      I := Pos('"InstallLocation"', Text);
      if I = 0 then Continue;
      Candidate := VdfValue(Copy(Text, I, 400), 'InstallLocation'); // JSON uses the same "key": "value" shape
      if Candidate = '' then
      begin
        Candidate := Copy(Text, I + 17, 400);
        Candidate := Copy(Candidate, Pos('"', Candidate) + 1, MaxInt);
        Candidate := Copy(Candidate, 1, Pos('"', Candidate) - 1);
        StringChangeEx(Candidate, '\\', '\', True);
      end;
      if GameFolderOk(Candidate) then begin Result := Candidate; Exit; end;
    until not FindNext(Find);
  finally
    FindClose(Find);
  end;
end;

function DefaultGameDir(Param: String): String;
begin
  Result := FindSteamGame;
  if Result = '' then Result := FindEpicGame;
  if Result = '' then Result := ExpandConstant('{autopf}');
end;

// ---- validation ------------------------------------------------------------------

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = wpSelectDir then
    if not GameFolderOk(WizardDirValue) then
    begin
      MsgBox(FmtMessage(CustomMessage('GameNotFound'), ['{#GameCheck}']), mbError, MB_OK);
      Result := False;
    end;
end;
