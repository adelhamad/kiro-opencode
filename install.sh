#!/usr/bin/env bash
set -euo pipefail

version=0.2.1
for executable in bun curl tar; do
  command -v "$executable" >/dev/null || { echo "Install $executable first, then run this installer again." >&2; exit 1; }
done

install_base="${KIRO_OPENCODE_INSTALL_DIR:-$HOME/.local/share/opencode-kiro}"
mkdir -p "$install_base"
staging=$(mktemp -d "$install_base/.download.XXXXXX")
trap 'rm -rf "$staging"' EXIT
curl --fail --silent --show-error --location \
  "https://github.com/adelhamad/kiro-opencode/releases/download/v$version/opencode-kiro-$version.tgz" \
  --output "$staging/package.tgz"
tar -xzf "$staging/package.tgz" -C "$staging"
(cd "$staging/package" && bun install --production --frozen-lockfile)

# Each install gets a separate directory, so a failed download never overwrites
# a working installation and existing processes can finish using their files.
destination="$install_base/$version-$(basename "$staging")"
mv "$staging/package" "$destination"
bun "$destination/scripts/install.ts"
ln -sfn "$destination" "$install_base/current"
echo "Plugin files: $destination"
echo "Run: opencode service restart"
echo "Then reopen OpenCode and select Kiro CLI in /models."
