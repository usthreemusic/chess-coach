"""Stamp a built copy of the site with a version, so browsers never mix old and new files.

GitHub Pages lets browsers keep each file for a while. After a deploy, a phone can hold an old
copy of one script and fetch a new copy of another; if the new one imports something the old one
does not have, the page fails to load. Adding ?v=<version> to every reference to our own scripts
and styles makes each deploy a fresh, consistent set of addresses.

Usage: python pipeline/stamp_site.py <site directory> <version>
Vendored files (site/vendor) never change between deploys and are left alone.
"""
import pathlib
import re
import sys

# import ... from "./x.js" / export ... from "../x.js" / import "./x.js"
JS_IMPORT = re.compile(r'''((?:from|import)\s*["'])(\.{1,2}/[^"']+\.js)(["'])''')
# <script src="js/x.js">, <link href="css/x.css">
HTML_REF = re.compile(r'''((?:src|href)=["'])((?:js|css)/[^"'?]+\.(?:js|css))(["'])''')


def stamp(text, pattern, version):
    def repl(match):
        if "vendor/" in match.group(2):
            return match.group(0)
        return f"{match.group(1)}{match.group(2)}?v={version}{match.group(3)}"
    return pattern.sub(repl, text)


def main(site, version):
    site = pathlib.Path(site)
    changed = 0
    for path in sorted(site.rglob("*")):
        if path.suffix not in (".js", ".html") or "vendor" in path.relative_to(site).parts:
            continue
        old = path.read_text(encoding="utf-8")
        new = stamp(old, JS_IMPORT, version)
        if path.suffix == ".html":
            new = stamp(new, HTML_REF, version)
        if new != old:
            path.write_text(new, encoding="utf-8")
            changed += 1
    print(f"Stamped {changed} file(s) with v={version}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
