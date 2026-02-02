const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

function absUrl(url) {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  return `https://nautichandler.com${url.startsWith("/") ? "" : "/"}${url}`;
}

function isBadProductUrl(u) {
  return (
    u.includes("contact") ||
    u.includes("privacy") ||
    u.includes("terms") ||
    u.includes("/content/")
  );
}

app.get("/health", (_, res) => res.json({ ok: true }));

app.get("/products", async (req, res) => {
  const url = String(
    req.query.url || "https://nautichandler.com/en/100390-painting"
  );

  if (!url.startsWith("https://nautichandler.com/")) {
    return res.status(400).json({ error: "Invalid url" });
  }

  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    const cookieSelectors = [
      "button:has-text('Accept all')",
      "button:has-text('Accept')",
      "button:has-text('I agree')",
      "button:has-text('OK')",
    ];
    for (const sel of cookieSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.count()) {
          await btn.click({ timeout: 1000 });
          break;
        }
      } catch {}
    }

    await page.waitForTimeout(800);

    const linkCount = await page.locator('a[href$=".html"]').count();
    console.log("product links:", linkCount);

    const rawProducts = await page.$$eval('a[href$=".html"]', (links) => {
      const pickText = (root, sel) => {
        const el = root.querySelector(sel);
        return el ? (el.textContent || "").trim() : "";
      };
      const pickAttr = (root, sel, attr) => {
        const el = root.querySelector(sel);
        return el ? el.getAttribute(attr) : null;
      };

      const results = [];

      for (const a of links) {
        const href = a.getAttribute("href");
        if (!href) continue;

        const card = a.closest("article") || a.closest("li") || a.closest("div");
        if (!card) continue;

        const txt = (a.textContent || "").trim().toLowerCase();
        const cls = (a.getAttribute("class") || "").toLowerCase();
        const rel = (a.getAttribute("rel") || "").toLowerCase();

        if (txt.includes("quick view") || cls.includes("quick-view") || rel.includes("nofollow")) {
          continue;
        }

        const title =
          pickText(card, ".product-title") ||
          pickText(card, ".product-title a") ||
          pickText(card, "h2") ||
          pickText(card, "h3") ||
          a.getAttribute("title") ||
          "";

        if (!title || title.length < 3) continue;

        const price =
          pickText(card, ".price") ||
          pickText(card, '[class*="price"]') ||
          null;

        const oldPrice =
          pickText(card, ".regular-price") ||
          pickText(card, '[class*="regular"]') ||
          null;

        const img =
          pickAttr(card, "img", "data-src") ||
          pickAttr(card, "img", "data-original") ||
          pickAttr(card, "img", "src") ||
          null;

        const hasEuro = (price || "").includes("€");
        const hasImg = !!img;
        if (!hasEuro && !hasImg) continue;

        results.push({
          title,
          price,
          oldPrice,
          stock: null,
          imageUrl: img,
          sourceUrl: href,
        });
      }

      return results;
    });

    const seen = new Set();
    const products = [];

    for (const p of rawProducts) {
      const sourceUrl = absUrl(p.sourceUrl);
      if (!sourceUrl) continue;
      if (isBadProductUrl(sourceUrl)) continue;

      if (seen.has(sourceUrl)) continue;
      seen.add(sourceUrl);

      products.push({
        title: p.title,
        price: p.price,
        oldPrice: p.oldPrice,
        stock: p.stock,
        imageUrl: p.imageUrl ? absUrl(p.imageUrl) : null,
        sourceUrl,
      });
    }

    return res.json({
      source: url,
      count: products.length,
      products: products.slice(0, 40),
    });
  } catch (e) {
    return res.status(502).json({ error: "Scrape failed", details: String(e) });
  } finally {
    if (browser) await browser.close();
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`scraper worker on :${port}`));
