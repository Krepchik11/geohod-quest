#!/usr/bin/env python3
"""Build Russian documentation PDF from docs/ru/*.md"""
from __future__ import annotations

import base64
import re
import textwrap
import time
import zlib
from io import BytesIO
from pathlib import Path

import markdown
import requests
from bs4 import BeautifulSoup, NavigableString, Tag
from fpdf import FPDF

ROOT = Path(__file__).resolve().parents[2]
DOCS_RU = ROOT / "docs" / "ru"
OUT_DIR = ROOT / "docs" / "ru" / "pdf"
IMG_CACHE = ROOT / "discovery" / "raw" / "pdf_images"
FONT = Path("/usr/share/fonts/TTF/DejaVuSans.ttf")
FONT_BOLD = Path("/usr/share/fonts/TTF/DejaVuSans-Bold.ttf")
FONT_OBLIQUE = Path("/usr/share/fonts/TTF/DejaVuSans-Oblique.ttf")
FONT_MONO = Path("/usr/share/fonts/TTF/DejaVuSansMono.ttf")

DOC_ORDER = [
    "README.md",
    "00-obzor.md",
    "01-chto-takoe-geoquest.md",
    "02-struktura-dannyh.md",
    "03-stranicy-i-scenarii.md",
    "04-biznes-logika.md",
    "05-integracii.md",
    "06-migraciya.md",
    "glossariy.md",
]


EMOJI_MAP = {
    "✅": "[+]",
    "❌": "[-]",
    "📋": "[doc]",
    "🔴": "[!!]",
    "🟡": "[~]",
    "🟢": "[ok]",
    "⚠️": "[!]",
    "⚠": "[!]",
    "🎯": "",
    "📅": "",
    "👤": "",
    "🇷🇺": "RU",
}


def strip_emoji(text: str) -> str:
    for k, v in EMOJI_MAP.items():
        text = text.replace(k, v)
    return text


def mermaid_ink_url(code: str) -> str:
    encoded = base64.urlsafe_b64encode(code.encode("utf-8")).decode("ascii")
    return f"https://mermaid.ink/img/{encoded}?type=png&bgColor=white"


def kroki_url(code: str) -> str:
    compressed = zlib.compress(code.encode("utf-8"), 9)
    encoded = base64.urlsafe_b64encode(compressed).decode("ascii")
    return f"https://kroki.io/mermaid/png/{encoded}"


def fetch_mermaid_png(code: str, cache_key: str) -> bytes | None:
    IMG_CACHE.mkdir(parents=True, exist_ok=True)
    cache_file = IMG_CACHE / f"{cache_key}.png"
    if cache_file.exists():
        return cache_file.read_bytes()

    for attempt, url in enumerate([
        mermaid_ink_url(code),
        kroki_url(code),
    ]):
        for retry in range(3):
            try:
                r = requests.get(url, timeout=90)
                if r.status_code == 200 and "image" in r.headers.get("content-type", ""):
                    cache_file.write_bytes(r.content)
                    return r.content
            except requests.RequestException:
                time.sleep(2 * (retry + 1))
        time.sleep(0.5)
    return None


def preprocess_mermaid(md_text: str, images: dict[str, bytes], counter: list[int]) -> str:
    def repl(match: re.Match) -> str:
        code = match.group(1).strip()
        counter[0] += 1
        n = counter[0]
        key = f"mermaid_{n}"
        png = fetch_mermaid_png(code, key)
        if png:
            images[key] = png
            return f"\n\n![Диаграмма {n}]({key})\n\n"
        fallback = textwrap.indent(code, "    ")
        return f"\n\n> Диаграмма (см. Markdown-версию):\n>\n> ```\n{fallback}\n> ```\n\n"

    return re.sub(r"```mermaid\s*\n(.*?)```", repl, md_text, flags=re.DOTALL)


def combine_markdown() -> tuple[str, dict[str, bytes]]:
    parts: list[str] = []
    all_images: dict[str, bytes] = {}
    counter = [0]

    for name in DOC_ORDER:
        path = DOCS_RU / name
        if not path.exists():
            continue
        text = strip_emoji(path.read_text(encoding="utf-8"))
        text = re.sub(r"^\[←.*\]\(.*\).*$", "", text, flags=re.MULTILINE)
        processed = preprocess_mermaid(text, all_images, counter)
        parts.append(f"\n\n---\n\n")
        parts.append(processed)

    return "\n".join(parts), all_images


class GeoQuestPDF(FPDF):
    def __init__(self, images: dict[str, bytes]):
        super().__init__(orientation="P", unit="mm", format="A4")
        self.images = images
        self.set_auto_page_break(auto=True, margin=18)
        self._register_fonts()

    def _register_fonts(self):
        self.add_font("DejaVu", "", str(FONT))
        self.add_font("DejaVu", "B", str(FONT_BOLD))
        self.add_font("DejaVu", "I", str(FONT_OBLIQUE))
        self.add_font("DejaVuMono", "", str(FONT_MONO))

    def header(self):
        if self.page_no() == 1:
            return
        self.set_font("DejaVu", "I", 8)
        self.set_text_color(120, 120, 120)
        self.cell(0, 6, "GeoQuest — документация проекта", align="L")
        self.ln(8)

    def footer(self):
        self.set_y(-12)
        self.set_font("DejaVu", "", 8)
        self.set_text_color(120, 120, 120)
        self.cell(0, 8, f"Стр. {self.page_no()}/{{nb}}", align="C")

    def write_html_ru(self, html: str):
        soup = BeautifulSoup(html, "html.parser")
        self.set_text_color(30, 30, 30)
        for element in soup.children:
            self._render_element(element)

    def _render_element(self, el):
        if isinstance(el, NavigableString):
            text = str(el).strip()
            if text:
                self._write_paragraph(text)
            return
        if not isinstance(el, Tag):
            return

        name = el.name
        if name in ("h1", "h2", "h3", "h4"):
            sizes = {"h1": 20, "h2": 16, "h3": 13, "h4": 11}
            self.ln(4)
            self.set_font("DejaVu", "B", sizes[name])
            self.multi_cell(0, 8, el.get_text(strip=True))
            self.ln(2)
        elif name == "p":
            imgs = el.find_all("img")
            if imgs:
                for img in imgs:
                    src = img.get("src", "")
                    if src in self.images:
                        self._render_image(self.images[src])
                    else:
                        self._write_paragraph(img.get("alt", "Диаграмма"))
                text = el.get_text(strip=True)
                if text and text != imgs[0].get("alt", ""):
                    self._write_paragraph(text)
            else:
                self._write_rich_paragraph(el)
            self.ln(2)
        elif name == "blockquote":
            self.set_font("DejaVu", "I", 10)
            self.set_fill_color(245, 247, 250)
            self.multi_cell(0, 6, el.get_text("\n", strip=True), fill=True)
            self.ln(2)
        elif name == "pre":
            code = el.get_text()
            self.set_font("DejaVuMono", "", 8)
            self.set_fill_color(245, 245, 245)
            self.multi_cell(0, 4.5, code, fill=True)
            self.ln(2)
        elif name == "table":
            self._render_table(el)
            self.ln(3)
        elif name == "ul":
            for li in el.find_all("li", recursive=False):
                self.set_font("DejaVu", "", 10)
                self.set_x(12)
                self.multi_cell(0, 5, f"• {li.get_text(strip=True)}")
            self.ln(1)
        elif name == "ol":
            for i, li in enumerate(el.find_all("li", recursive=False), 1):
                self.set_font("DejaVu", "", 10)
                self.set_x(12)
                self.multi_cell(0, 5, f"{i}. {li.get_text(strip=True)}")
            self.ln(1)
        elif name == "hr":
            self.ln(2)
            self.set_draw_color(200, 200, 200)
            self.line(10, self.get_y(), 200, self.get_y())
            self.ln(4)
        elif name == "img":
            src = el.get("src", "")
            if src in self.images:
                self._render_image(self.images[src])
            else:
                self._write_paragraph(el.get("alt", "Изображение"))
        else:
            for child in el.children:
                self._render_element(child)

    def _write_paragraph(self, text: str):
        self.set_font("DejaVu", "", 10)
        self.multi_cell(0, 5.5, text)

    def _write_rich_paragraph(self, el: Tag):
        self.set_font("DejaVu", "", 10)
        parts = []
        for child in el.children:
            if isinstance(child, NavigableString):
                parts.append(("normal", str(child)))
            elif isinstance(child, Tag):
                if child.name in ("strong", "b"):
                    parts.append(("bold", child.get_text()))
                elif child.name in ("em", "i"):
                    parts.append(("italic", child.get_text()))
                elif child.name == "code":
                    parts.append(("mono", child.get_text()))
                else:
                    parts.append(("normal", child.get_text()))
        line = "".join(t for _, t in parts).strip()
        if line:
            self.multi_cell(0, 5.5, line)

    def _render_table(self, table: Tag):
        rows = table.find_all("tr")
        if not rows:
            return
        data = []
        for row in rows:
            cells = row.find_all(["th", "td"])
            data.append([c.get_text(strip=True) for c in cells])
        if not data:
            return

        cols = max(len(r) for r in data)
        width = 190
        col_w = width / cols
        line_h = 6

        for r_idx, row in enumerate(data):
            row = row + [""] * (cols - len(row))
            y0 = self.get_y()
            if y0 > 260:
                self.add_page()
                y0 = self.get_y()
            self.set_font("DejaVu", "B" if r_idx == 0 else "", 8)
            if r_idx == 0:
                self.set_fill_color(230, 235, 245)
            else:
                self.set_fill_color(248, 248, 248)
            x = 10
            for cell in row:
                self.set_xy(x, y0)
                self.rect(x, y0, col_w, line_h * 2, style="DF")
                self.multi_cell(col_w, line_h, cell[:120], max_line_height=line_h, border=0)
                x += col_w
            self.set_xy(10, y0 + line_h * 2)

    def _render_image(self, data: bytes):
        try:
            self.ln(2)
            w = 180
            self.image(BytesIO(data), w=w)
            self.ln(4)
        except Exception:
            self._write_paragraph("[Диаграмма не загружена]")


def build_pdf():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print("Combining markdown + rendering mermaid diagrams...")
    md_text, images = combine_markdown()
    print(f"Mermaid images fetched: {len(images)}")

    html = markdown.markdown(
        md_text,
        extensions=["tables", "fenced_code", "nl2br", "sane_lists"],
    )

    # Cover page HTML prefix
    cover = """
    <h1>GeoQuest</h1>
    <h2>Документация проекта</h2>
    <p>Миграция с Bubble.io на Rust + Next.js</p>
    <p><strong>Дата:</strong> 8 июня 2026</p>
    <p><strong>Версия:</strong> 1.0</p>
    <hr>
    """

    pdf = GeoQuestPDF(images)
    pdf.alias_nb_pages()
    pdf.add_page()
    pdf.write_html_ru(cover)
    pdf.add_page()
    pdf.write_html_ru(html)

    out_path = OUT_DIR / "GeoQuest-Dokumentaciya-RU.pdf"
    pdf.output(str(out_path))
    print(f"PDF saved: {out_path} ({out_path.stat().st_size // 1024} KB)")
    return out_path


if __name__ == "__main__":
    build_pdf()