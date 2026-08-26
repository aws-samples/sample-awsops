#!/bin/bash
# When a web guide doc (docs-site/docs/**/*.md) is created/edited,
# check if the corresponding i18n English translation exists.

FILE_PATH="${1:-}"
[ -z "$FILE_PATH" ] && exit 0

# Only trigger for docs-site/docs/ markdown files (not i18n)
[[ "$FILE_PATH" != docs-site/docs/*.md ]] && exit 0

# Derive relative path within docs/
REL_PATH="${FILE_PATH#docs-site/docs/}"

I18N_PATH="docs-site/i18n/en/docusaurus-plugin-content-docs/current/$REL_PATH"

if [ ! -f "$I18N_PATH" ]; then
    echo "[guide-i18n-sync] Korean guide updated but English translation missing: $I18N_PATH — Create the English version of $FILE_PATH"
fi
