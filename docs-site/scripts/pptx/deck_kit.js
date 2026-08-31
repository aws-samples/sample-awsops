// ════════════════════════════════════════════════════════════════
// deck_kit.js — AWS Light deck design system (Pretendard), vendored
// from the AWS Korea V-team light template for the awsops-intro deck.
// Self-contained: requires only pptxgenjs + the PNG assets in ./assets.
// Trimmed to the builders this deck actually uses (cover / agenda /
// sectionDivider / closing + shared helpers); the upstream kit has more.
// ════════════════════════════════════════════════════════════════
const pptxgen = require("pptxgenjs");
const path = require("path");

const ASSETS = path.join(__dirname, "assets");
const LOGO = path.join(ASSETS, "aws_logo.png");
const LOGO_WHITE = path.join(ASSETS, "aws_logo_white.png");
const LOGO_AR = 412 / 247;
const BG_COVER = path.join(ASSETS, "cover_glow.png");
const BG_SECTION = path.join(ASSETS, "section_grad.png");
const GRAD_PILL = path.join(ASSETS, "grad_pill.png");

const FONT = "Pretendard";
const W = 13.333, H = 7.5, PAD = 0.92;

// ─── Korean text layout helpers ─────────────────────────────────
// Pretendard 한국어 글자는 영어보다 ~1.55× 넓음. PptxGenJS는 렌더링 전
// 높이를 측정할 수 없으므로 줄 수를 직접 추정한다.
const KO_CHAR_RATIO = 1.55;
const EN_CHAR_W_PER_PT = 0.50;

function estimateLines(text, widthInch, fontSize) {
  const koCount = (text.match(/[가-힣]/g) || []).length;
  const enCount = text.length - koCount;
  const effectiveChars = koCount * KO_CHAR_RATIO + enCount;
  const charsPerLine = (widthInch * 72) / (fontSize * EN_CHAR_W_PER_PT);
  return Math.max(1, Math.ceil(effectiveChars / charsPerLine));
}

function autoH(text, widthInch, fontSize, lineSpacing, minH) {
  const lines = estimateLines(text, widthInch, fontSize);
  const lineH = (fontSize / 72) * (lineSpacing || 1.3) * 1.15;
  return Math.max(minH || 0, lines * lineH);
}

function safeText(extraOpts) {
  return { wrap: true, ...extraOpts };
}

// ─── Design tokens ──────────────────────────────────────────────
const C = {
  bg: "FFFFFF", card: "F4F4F8", cardSoft: "F7F7FB", hairline: "D2D2D5",
  ink: "161D26", body: "3F4858", muted: "6B7280", faint: "999999",
  gradPurple: "AD5CFF", gradBlue: "41B3FF", gradGreen: "00E500",
  purple: "8B5CF6", blue: "3B82F6", blueBright: "007DFF", magenta: "E91E63", green: "00B341",
  purpleTint: "F2EEFF", blueTint: "EAF2FF", grayTint: "F2F2F4",
};

const COPYRIGHT = "© 2026, Amazon Web Services, Inc. or its affiliates. All rights reserved.";

function newDeck() {
  const pres = new pptxgen();
  pres.defineLayout({ name: "W16x9", width: W, height: H });
  pres.layout = "W16x9";
  pres.author = "AWS Korea";
  return pres;
}

function mkShadow() {
  return { type: "outer", color: "9AA0B0", blur: 10, offset: 3, angle: 90, opacity: 0.18 };
}

const icon = (n) => path.join(ASSETS, n + ".png");

// ─── footer: copyright (left) · small AWS logo + page num (right) ───
function addFooter(pres, s, pageNum, withLogo = true, variant = "dark") {
  const white = variant === "light";
  const txtColor = white ? "FFFFFF" : C.faint;
  s.addText(COPYRIGHT, {
    x: PAD, y: 7.06, w: 8.2, h: 0.3, fontFace: FONT, fontSize: 8,
    color: txtColor, align: "left", valign: "middle", transparency: white ? 25 : 0,
  });
  if (withLogo) {
    const lh = 0.26, lw = lh * LOGO_AR;
    // altText REQUIRED on every addImage: pptxgenjs writes `descr=altText||<abs path>`,
    // and an absolute build path would break CI rebuild parity (and leak the build host path)
    s.addImage({ path: white ? LOGO_WHITE : LOGO, x: 11.55, y: 6.96, w: lw, h: lh, altText: "AWS logo" });
  }
  if (pageNum != null) {
    s.addText(String(pageNum), {
      x: 12.5, y: 7.06, w: 0.4, h: 0.3, fontFace: FONT, fontSize: 9,
      color: txtColor, align: "right", valign: "middle", transparency: white ? 25 : 0,
    });
  }
}

// ─── content header: title (+ optional subtitle) ───
function addHeader(pres, s, title, subtitle) {
  const titleH = autoH(title, 11.4, 30, 1.1, 0.8);
  s.addText(title, safeText({
    x: PAD - 0.02, y: 0.55, w: 11.4, h: titleH, fontFace: FONT, fontSize: 30, bold: true,
    color: C.ink, charSpacing: -0.8, align: "left", valign: "top",
  }));
  if (subtitle) {
    const subY = 0.55 + titleH + 0.05;
    const subH = autoH(subtitle, 11.4, 14, 1.2, 0.4);
    s.addText(subtitle, safeText({
      x: PAD, y: subY, w: 11.4, h: subH, fontFace: FONT, fontSize: 14,
      color: C.muted, align: "left", valign: "top",
    }));
  }
}

function applyBg(s) {
  s.background = { color: C.bg };
}

// ─── LAYOUT: COVER ───
function cover(pres, opts) {
  const s = pres.addSlide();
  s.background = { path: BG_COVER };
  s.addText(opts.product, {
    x: PAD - 0.04, y: 2.45, w: 11.5, h: 1.1, fontFace: FONT, fontSize: 54, bold: true,
    color: C.ink, charSpacing: -1, align: "left", valign: "top",
  });
  if (opts.subtitle) {
    s.addText(opts.subtitle, {
      x: PAD, y: 3.62, w: 11, h: 1.0, fontFace: FONT, fontSize: 22, color: C.body,
      lineSpacingMultiple: 1.18, align: "left", valign: "top",
    });
  }
  if (opts.date) {
    s.addText(opts.date, {
      x: PAD, y: 4.95, w: 6, h: 0.4, fontFace: FONT, fontSize: 13, italic: true,
      color: C.muted, align: "left", valign: "middle",
    });
  }
  if (opts.presenter) {
    const p = opts.presenter;
    s.addText([
      { text: p.name || "", options: { bold: true, color: C.ink, fontSize: 15, breakLine: true } },
      { text: p.title || "", options: { color: C.body, fontSize: 13, breakLine: true } },
      { text: p.org || "", options: { color: C.body, fontSize: 13 } },
    ], { x: PAD, y: 5.5, w: 6, h: 1.0, fontFace: FONT, align: "left", valign: "top", lineSpacingMultiple: 1.18 });
  }
  const h = 0.52, w = h * LOGO_AR;
  s.addImage({ path: LOGO, x: W - PAD - w, y: H - 0.95, w, h, altText: "AWS logo" });
  addFooter(pres, s, null, false);
  if (opts.notes) s.addNotes(opts.notes);
  return s;
}

// ─── LAYOUT: AGENDA (content chapters only) ───
function agenda(pres, opts) {
  const s = pres.addSlide();
  applyBg(s);
  s.addText(opts.title || "Agenda", {
    x: PAD - 0.02, y: 0.62, w: 11, h: 0.85, fontFace: FONT, fontSize: 38, bold: true,
    color: C.ink, charSpacing: -1, align: "left", valign: "top",
  });
  const items = opts.items.slice(0, 6);
  const colX = [PAD, 7.05];
  const colW = 5.3;
  const rows = Math.ceil(items.length / 2);
  const yTop = rows <= 2 ? 2.55 : 2.15;
  const rowH = rows <= 2 ? 1.5 : 1.25;

  items.forEach((it, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = colX[col], y = yTop + row * rowH;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x, y: y - 0.04, w: 0.66, h: 0.66, rectRadius: 0.12, fill: { color: C.blueTint }, line: { type: "none" },
    });
    if (it.iconPath) s.addImage({ path: it.iconPath, x: x + 0.14, y: y + 0.1, w: 0.38, h: 0.38, altText: "chapter " + it.num + " icon" });
    s.addText(it.num, safeText({ x: x + 0.86, y: y - 0.06, w: colW - 0.86, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: C.blue, align: "left", valign: "top", margin: 0, charSpacing: 0.5 }));
    s.addText(it.title, safeText({ x: x + 0.86, y: y + 0.2, w: colW - 0.86, h: 0.4, fontFace: FONT, fontSize: 16, bold: true, color: C.ink, align: "left", valign: "top", margin: 0, charSpacing: -0.3 }));
    if (it.desc) {
      const dw = colW - 0.86;
      const dh = autoH(it.desc, dw, 11.5, 1.2, 0.35);
      s.addText(it.desc, safeText({ x: x + 0.86, y: y + 0.62, w: dw, h: dh, fontFace: FONT, fontSize: 11.5, color: C.muted, align: "left", valign: "top", margin: 0 }));
    }
    if (row < rows - 1) s.addShape(pres.shapes.LINE, { x, y: y + rowH - 0.16, w: colW, h: 0, line: { color: C.hairline, width: 1 } });
  });
  addFooter(pres, s, opts.pageNum);
  if (opts.notes) s.addNotes(opts.notes);
  return s;
}

// ─── LAYOUT: SECTION DIVIDER (full gradient bg) ───
function sectionDivider(pres, opts) {
  const s = pres.addSlide();
  s.background = { path: BG_SECTION };
  if (opts.num) {
    s.addText(String(opts.num), {
      x: PAD, y: 1.7, w: 4, h: 1.2, fontFace: FONT, fontSize: 22, bold: true,
      color: "FFFFFF", align: "left", valign: "top", charSpacing: 3, transparency: 35,
    });
  }
  s.addText(opts.title, {
    x: PAD - 0.02, y: 2.95, w: 11, h: 1.4, fontFace: FONT, fontSize: 50, bold: true,
    color: "FFFFFF", charSpacing: -1, align: "left", valign: "top",
  });
  if (opts.kicker) {
    s.addText(opts.kicker, {
      x: PAD, y: 4.25, w: 10.5, h: 0.6, fontFace: FONT, fontSize: 18,
      color: "FFFFFF", align: "left", valign: "top", transparency: 12,
    });
  }
  addFooter(pres, s, opts.pageNum, true, "light");
  if (opts.notes) s.addNotes(opts.notes);
  return s;
}

// ─── LAYOUT: CLOSING (full gradient bg) ───
function closing(pres, opts = {}) {
  const s = pres.addSlide();
  s.background = { path: BG_SECTION };
  s.addText(opts.text || "Thank you.", {
    x: PAD - 0.02, y: 3.0, w: 11, h: 1.3, fontFace: FONT, fontSize: 54, bold: true,
    color: "FFFFFF", charSpacing: -1, align: "left", valign: "middle",
  });
  addFooter(pres, s, opts.pageNum, true, "light");
  if (opts.notes) s.addNotes(opts.notes);
  return s;
}

module.exports = {
  pptxgen, newDeck, FONT, W, H, PAD, C, COPYRIGHT,
  ASSETS, LOGO, LOGO_AR, BG_COVER, GRAD_PILL,
  icon, mkShadow, addFooter, addHeader, applyBg,
  KO_CHAR_RATIO, estimateLines, autoH, safeText,
  cover, agenda, sectionDivider, closing,
};
