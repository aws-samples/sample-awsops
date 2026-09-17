#!/usr/bin/env python3
"""Render the blog Markdown to its local, offline HTML preview.

Install requirements-preview.txt, then run this script from any directory.
Only preview.html beside this script is written; no AWS calls or image generation.
"""
from pathlib import Path
import html
import re

import markdown

ROOT = Path(__file__).resolve().parent


def make_preview():
    text = (ROOT / "draft-awsops-architecture.md").read_text(encoding="utf-8")
    parser = markdown.Markdown(extensions=["tables", "fenced_code", "toc"])
    content = parser.convert(text)

    def figure(match):
        image, src = match.group(1), match.group(2)
        width_class = "" if src.endswith("fig1-sre-workflow.png") else " figure-wide"
        escaped_src = html.escape(src, quote=True)
        return (
            f'<p class="figure{width_class}"><a href="{escaped_src}" title="원본 크기로 보기">{image}</a>'
            f'<a class="figure-original" href="{escaped_src}">그림 원본 크게 보기</a></p>'
        )

    content = re.sub(r'<p>(<img\b[^>]*\bsrc="([^"]+)"[^>]*>)</p>', figure, content)

    def headings(tokens):
        for token in tokens:
            if token["level"] == 2:
                yield token
            yield from headings(token.get("children", []))

    links = "".join(
        f'<li><a href="#{html.escape(item["id"], quote=True)}">{html.escape(item["name"])}</a></li>'
        for item in headings(parser.toc_tokens)
        if item["name"] != "참고 자료"
    )
    navigation = f'<details class="article-toc"><summary>이 글의 흐름</summary><nav aria-label="글 목차"><ol>{links}</ol></nav></details>'
    content = content.replace("</h1>", "</h1>" + navigation, 1)
    title = html.escape(next(line[2:] for line in text.splitlines() if line.startswith("# ")))
    # This is an editorial preview of the Markdown, with no remote fonts or scripts.
    page = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>""" + title + """</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#fff;color:#232f3e;font-family:"Noto Sans CJK KR","Noto Sans KR",Arial,sans-serif;font-size:18px;line-height:1.95;word-break:keep-all;overflow-wrap:anywhere}
header{border-top:5px solid #ff9900;border-bottom:1px solid #e5e7eb;padding:18px max(24px,calc((100vw - 840px)/2));font-size:14px;line-height:1.5;color:#566573}
main{max-width:888px;padding:42px 24px 88px;margin:auto}
h1{font-size:38px;line-height:1.4;letter-spacing:-1px;margin:0 0 34px}
h2{font-size:28px;line-height:1.45;margin:58px 0 22px;letter-spacing:-.6px}
h3{font-size:23px;line-height:1.5;margin:42px 0 18px}
p{margin:0 0 22px}a{color:#0875b7;text-underline-offset:3px}
blockquote{margin:24px 0;padding:18px 24px;border-left:4px solid #ff9900;background:#f7f9fb;border-radius:0 8px 8px 0}
blockquote p{margin:0}strong{font-weight:750}
.figure{margin:34px auto 16px;text-align:center}.figure img{display:block;width:100%;max-width:640px;height:auto;margin:auto}
.figure-wide img{max-width:840px}
.figure-original{display:inline-block;margin-top:10px;padding:8px 12px;font-size:19px;line-height:1.6}
.figure+ p{font-size:15px;line-height:1.8;color:#52616b}
.article-toc{margin:0 0 34px;padding:14px 20px;border:1px solid #d9e1e8;border-radius:8px;font-size:15px;background:#fafbfd}
.article-toc summary{cursor:pointer;font-weight:650}.article-toc ol{margin:12px 0 2px;padding-left:22px}.article-toc li{margin:7px 0}
code{font-family:ui-monospace,"SFMono-Regular",Consolas,monospace;font-size:.88em;background:#f2f5f8;border-radius:3px;padding:2px 4px}
pre{max-width:100%;overflow-x:auto;background:#f5f7fa;border:1px solid #dce3eb;border-radius:8px;padding:18px 20px;margin:24px 0;line-height:1.7;font-size:15px;word-break:normal;overflow-wrap:normal}
pre code{background:none;padding:0;font-size:inherit;white-space:pre}
h2,h3{scroll-margin-top:24px}
table{border-collapse:collapse;table-layout:fixed;width:100%;margin:24px 0 30px;font-size:16px;line-height:1.8}
th,td{text-align:left;padding:14px 16px;border:1px solid #d9e1e8;vertical-align:top}th{background:#f4f7fa}th:first-child,td:first-child{width:26%}
ul{padding-left:24px;font-size:16px}li{margin:10px 0}
@media(max-width:600px){body{font-size:17px;line-height:1.9}header{padding:14px 20px}main{padding:30px 20px 60px}h1{font-size:29px;letter-spacing:-.5px}h2{font-size:24px;margin-top:42px}h3{font-size:21px}blockquote{padding:16px}table{font-size:14px}th,td{padding:10px}th:first-child,td:first-child{width:31%}}
@media print{header,.article-toc{display:none}main{max-width:none;padding:0}h2,h3{break-after:avoid}img,table,blockquote,pre{break-inside:avoid}body{font-size:11pt}h1{font-size:23pt}h2{font-size:17pt}h3{font-size:14pt}}
</style></head><body>
<header>AWS Blog 원고 미리보기 · 2026-09-13</header><main>""" + content + "</main></body></html>\n"
    (ROOT / "preview.html").write_text(page, encoding="utf-8")
    print(f"Preview written: {ROOT / 'preview.html'}")


if __name__ == "__main__":
    make_preview()
