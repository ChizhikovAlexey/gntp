#!/bin/sh
# Builds release packages for store submission:
#   dist/gntp-firefox-<version>.zip   — upload to addons.mozilla.org
#   dist/gntp-chromium-<version>.zip  — upload to the Chrome Web Store
#   dist/gntp-source-<version>.zip    — source package for AMO review
#     (taken from the committed tree: commit before packaging)
set -e
cd "$(dirname "$0")"

./build.sh
version=$(jq -r .version extension/manifest.json)

rm -f "dist/gntp-firefox-$version.zip" "dist/gntp-chromium-$version.zip" \
	"dist/gntp-source-$version.zip"
(cd dist/firefox && zip -qr "../gntp-firefox-$version.zip" .)
(cd dist/chromium && zip -qr "../gntp-chromium-$version.zip" .)
git archive --format=zip -o "dist/gntp-source-$version.zip" HEAD

ls -la dist/*.zip
