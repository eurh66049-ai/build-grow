## السياق المُكتشف

- جدول `books` و `book_media` في Supabase **فارغان** (0 سجلات)
- بيانات الكتب الحالية مخزنة في ملف ثابت: `src/data/editableBooksData.ts`
- ملفات الكتب المرفوعة من المستخدمين تذهب إلى Supabase Storage في bucketين: `book-covers` و `book-files`
- معلومات الكتاب المرفوع تُحفظ في جدول `book_submissions` (للمراجعة)
- AWS S3 connector مرتبط بنجاح: bucket = `kotobi`, region = `eu-north-1`

## الخطة

### 1. إعداد Backend للتفاعل مع S3

ملف جديد: `src/lib/s3.functions.ts`
- `getS3UploadUrl({ fileName, contentType, folder })` — يُرجع signed URL للرفع المباشر من المتصفح
- `getS3DownloadUrl({ objectKey })` — يُرجع signed URL لقراءة الملف (يُستخدم لعرض PDF)
- `getS3PublicUrl({ objectKey })` — يبني المسار المرجعي للحفظ في DB

كل هذه دوال `createServerFn` تستخدم gateway endpoint `sign_storage_url` مع secrets `LOVABLE_API_KEY` و `AWS_S3_API_KEY`.

### 2. تعديل نظام الرفع

ملف معدّل: `src/components/upload/SimpleBookUploader.tsx`
- استبدال `supabase.storage.upload(...)` بـ:
  1. استدعاء server fn للحصول على signed upload URL
  2. `fetch(uploadUrl, { method: 'PUT', body: file })` للرفع المباشر إلى S3
  3. حفظ المسار `s3://kotobi/<folder>/<filename>` في `book_submissions` بدل الـ public URL

### 3. عرض الملفات من S3

ملف جديد: `src/utils/s3FileResolver.ts`
- دالة `resolveBookFileUrl(storedUrl)`:
  - إذا كان المسار يبدأ بـ `s3://kotobi/` → استدعاء server fn للحصول على signed download URL
  - وإلا (URL Supabase حالي) → إرجاعها كما هي
- تكامل مع `src/utils/fileValidator.ts` و قارئ PDF

### 4. كتاب التجربة

اختيار "رواية الأبله الجزء الأول" (موجود فعلياً في `editableBooksData.ts`) كحالة اختبار:
- نسخ ملف PDF والغلاف من رابطه الحالي (Supabase أو خارجي) إلى S3
- تحديث `bookReadingUrls.ts` ليشير الكتاب إلى مسار S3
- التأكد من ظهور الكتاب وفتحه من S3

### 5. CORS على bucket كتبي

قبل الاختبار، يجب التأكد أن bucket `kotobi` يسمح بـ CORS من `https://*.lovable.app` للـ methods: GET, PUT, HEAD. هذا يُعدّل من AWS Console (Bucket → Permissions → CORS) — لا يمكن لي عمله برمجياً.

## تفاصيل تقنية

**Gateway endpoint للرفع:**
```
POST https://connector-gateway.lovable.dev/api/v1/sign_storage_url?provider=aws_s3&mode=write
Headers: Authorization: Bearer $LOVABLE_API_KEY, X-Connection-Api-Key: $AWS_S3_API_KEY
Body: { "object_path": "covers/123_abc.jpg" }
→ { "url": "https://s3...", "method": "PUT", "expires_in": 900 }
```

**ملاحظة مهمة:** S3 لا يدعم public URLs مباشرة عبر gateway — كل عرض ملف لاحق يتطلب signed URL جديد (صالح 15 دقيقة افتراضياً). هذا يعني كل قارئ PDF يحتاج استدعاء server fn قبل الفتح.

**ما لن يتغير:**
- بنية جدول `book_submissions`: حقل `pdf_url` يقبل النوعين (Supabase URL أو `s3://...` مرجع)
- ملف `editableBooksData.ts` للكتب القديمة
- نظام المراجعة والموافقة

## الترتيب
1. CORS setup (يدوياً من قبلك على AWS)
2. إنشاء `s3.functions.ts`
3. تعديل `SimpleBookUploader.tsx`
4. إنشاء `s3FileResolver.ts` ودمجه في القارئ
5. اختبار رفع كتاب جديد
6. اختبار كتاب الأبله من S3
