#!/usr/bin/env sh
# 交叉编译 Windows 桌面版 → dist/CSVLens.exe（Linux / macOS / Git Bash 均可，需要 Go 1.24+）
set -eu
cd "$(dirname "$0")/.."
VERSION="${VERSION:-1.0.0}"
mkdir -p dist
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath \
  -ldflags "-H windowsgui -s -w -X main.version=$VERSION" \
  -o dist/CSVLens.exe ./cmd/csvlens
echo "built dist/CSVLens.exe"
