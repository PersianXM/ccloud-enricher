# CCloud Enricher

پروکسی enrichment برای اپ CCloud: پاس‌ترافیک شفاف API سی‌نما + تزریق امتیازهای Rotten Tomatoes (🍅 Tomatometer + 🍿 Popcornmeter).

## معماری

```
اپ اندروید → این سرویس (Render) ──► API اصلی سی‌نما (pass-through)
                        └──(فقط cache miss)──► whatson-api (Render)
```

- چرا این سرویس وجود داره: Render ترافیک خروجی Cloudflare Workers رو بلاک می‌کنه؛ Render→Render آزاده
- پاسخ دقیقاً همون JSON اصلی + دو فیلد اختیاری `tomatometer`/`popcornmeter`
- عناوین غیرلاتین skip میشن (RT نمی‌تونه match کنه — بدون داده جعلی)
- کش درون‌حافظه: امتیاز ۷ روز / عدم‌وجود ۲۴ ساعت / شکست موقت کش نمیشه

## دیپلوی روی Render (رایگان)

| تنظیم | مقدار |
|---|---|
| Language | Node |
| Branch | main |
| Build Command | `npm install` (یا خالی) |
| **Start Command** | `node index.js` |
| Instance Type | Free |

Environment Variables (اختیاری):

| کلید | پیش‌فرض | توضیح |
|---|---|---|
| `UPSTREAM_HOST` | `https://server-hi-speed-iran.info` | API اصلی |
| `WHATSON_BASE` | `https://whatson-api.onrender.com/` | منبع امتیاز RT |
| `WHATSON_API_KEY` | خالی | کلید رایگان = ۵۰۰ req/h به‌جای ۱۰۰ |
| `ENRICH_TIMEOUT_MS` | `10000` | سقف زمان enrichment هر پاسخ |

## تست

```bash
curl "https://<your-app>.onrender.com/health"
curl "https://<your-app>.onrender.com/api/search/top%20gun/4F5A9C3D9A86FA54EACEDDD635185/"
```

آیتم‌های دارای امتیاز RT فیلدهای `tomatometer`/`popcornmeter` + هدر `x-ccloud-enriched: 1` خواهند داشت.

## نکته Render Free

سرویس بعد از ۱۵ دقیقه بی‌کاری می‌خوابه؛ اولین درخواست بعد از خواب ~۳۰-۵۰ ثانیه طول می‌کشه. برای بیدار موندن می‌تونی از UptimeRobot (ping هر ۱۰ دقیقه به `/health`) استفاده کنی.
