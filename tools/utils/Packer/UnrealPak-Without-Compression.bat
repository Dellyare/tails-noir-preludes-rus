@setlocal enableextensions
@pushd %~dp0
@echo "..\..\..\TailsRUS_P\*.*" "..\..\..\*.*" >filelist.txt
.\UnrealPak.exe "..\..\..\build\TailsRUS_P.pak" -create=filelist.txt
@popd

:skip
