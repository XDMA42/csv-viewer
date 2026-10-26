@echo off
rem Build the Windows desktop app on Windows (requires Go 1.24+) -> dist\CSVLens.exe
setlocal
cd /d "%~dp0.."
if not defined VERSION set VERSION=1.0.0
if not exist dist mkdir dist
set GOOS=windows
set GOARCH=amd64
set CGO_ENABLED=0
go build -trimpath -ldflags "-H windowsgui -s -w -X main.version=%VERSION%" -o dist\CSVLens.exe .\cmd\csvlens
if errorlevel 1 exit /b 1
echo built dist\CSVLens.exe
