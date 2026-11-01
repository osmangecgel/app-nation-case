# app-nation-case

Bu repo, AppNation backend case'inin çözümüdür: kredi ile ücretlendirilen asenkron AI işleri için bir API ve ayrı bir worker. Bir NestJS başlangıç şablonundan türedi; altyapı (PostgreSQL, Prisma, Redis, Kafka, loglama) ve kodlama standartları oradan gelir. Standartların tamamı `docs/standards/` altındadır. Bu dosya yalnızca nereye bakılacağını ve çalışma sürecini anlatır.

Standart dosyaları ve teslim dokümanları İngilizcedir. Teslim dokümanları: `README.md` (case gereği en fazla 300 kelime) ve `docs/design.md` (kararlar, doğrulama sonuçları, EXPLAIN ANALYZE). Kodun davranışı değişirse bu iki dosyayı da güncelle.

## Mevcut durum

Standartların bir kısmı koda uygulandı. Standart dokümanları hedef yapıyı tanımlar. Kod ile doküman çeliştiğinde doküman geçerlidir. Çelişkiyi kullanıcıya bildir.

Uygulananlar (1 Kasım 2026):

- Klasör yapısı (`shared`, `core`, `infra`, `modules`), `#` import yolları (Prisma'nın `prisma/generated` klasörüne ürettiği kod için `#generated`) ve `.ts` uzantılı import'lar
- Kodlama ve mimari lint kuralları (`.oxlintrc.json`) ve Prettier biçimi (satır uzunluğu 120, `npm run format:check`)
- Prisma şema klasörü (`prisma/schema`)
- Docker Compose: uygulama (13400), worker, PostgreSQL (15432), Redis (16390) ve Kafka (19092). Migration'ları uygulamadan önce ayrı `migrate` servisi uygular (DB-19). `.env` isteğe bağlıdır; yoksa `.env.example` değerleri kullanılır. `seed`, `test` ve `verify` servisleri `tools` profilindedir, `docker compose up` ile başlamaz.
- `modules/health`: veritabanı ve Redis'in durumunu döner. Veritabanı çalışmıyorsa 503 (`error`), yalnızca Redis çalışmıyorsa 200 (`degraded`) verir
- `core/context`: her istek için `requestId` (`traceparent` başlığından veya yeni), yanıtta `x-request-id`. Worker'da her işin satırları `jobId` ve işi oluşturan isteğin `requestId` değerini taşır
- `core/logging`: `AppLogger` (JSON veya renkli, `requestId` ve `jobId`, camelCase alanlar, maskeleme; işin `input` ve `result` metni de maskelenir), istek giriş ve çıkış logları, `LOG_*` ayarları
- `core/errors`: hata sınıfları, hata kodları, RFC 9457 hata yakalayıcısı. `infra/database` Prisma hatalarını çevirir ve `LOG_DB_QUERIES` ile sorgu loglar.
- `core/validation`: `ZodValidationPipe`
- API dokümantasyonu: `@ApiEndpoint` (zod şemalarından), Swagger UI `/docs`, `docs/api/openapi.json` (`npm run docs:generate`, `npm run docs:check`)
- `core/http`: URL versiyonlaması (`/v1`, `/health` versiyonsuz) ve istek sınırı (IP ve uç nokta başına dakikada 1000, sayaçlar cache Redis'inde)
- `core/http/pagination.ts`: imleç ile sayfalama şeması ve yardımcıları (API-07)
- `infra/cache/cache.service.ts`: `CacheService` (get, set, kilit al ve bırak). Redis çalışmıyorsa hata vermez, "cache'te yok" der (CACHE-07).
- Test verisi sistemin kendi giriş noktalarıyla oluşturulur (TEST-05); yardımcılar `test/support` altında (`test-prisma.ts`, `credits.ts`, `controllable-ai-provider.ts`)
- Test veritabanı: e2e testleri `app_nation_case_test` veritabanını ve Redis'in 1 numaralı DB index'ini kullanır. Veritabanı yoksa oluşturulur, migration'lar uygulanır. Her testten önce tablolar ve test Redis'i boşaltılır (`test/support`).
- Kuyruk: port `infra/queue/queue.ts`, sürücü `QUEUE_DRIVER` ile seçilir (bugün yalnızca Kafka, `infra/queue/kafka`); AI provider adapter'ları `infra/ai-provider/adapters/`, `ai-provider.catalogue.ts` ve `AI_PROVIDER_ADAPTERS` ile yüklenir. Outbox ve relay, partition içinde paralel işleyen tüketici, reconciler. Case'in doğrulama akışı: `scripts/verify.sh`
- CSV export'un üç katmanı (API-15, API-16, CACHE-14): akan export'ta kullanıcı başına bir export ve tüm instance'larda en fazla `EXPORT_MAX_CONCURRENT` (Redis'te süreli izinler; Redis yoksa instance başına `EXPORT_FALLBACK_MAX_CONCURRENT`); arka planda export (`/v1/exports`, `job_exports` tablosu, `exports.process` topic'i, dosyalar `infra/file-store` portu ve paylaşılan Docker volume'ünde); `EXPORT_MODE` (`stream`, `async`, `auto`) `GET /v1/jobs/export.csv` yolunu seçer. Ayrıntılar `docs/design.md` bölüm 16

Henüz uygulanmayanlar:

- `userId`in her log satırına otomatik eklenmesi (kimlik doğrulama yok; bazı olaylar onu veri alanı olarak taşır)
- Global provider sınırı (`job_providers.max_concurrency` uygulanmıyor), Kafka'lı uçtan uca test
- Export dosyaları için object store adapter'ı (S3); bugün dosyalar tek host'taki paylaşılan volume'de
- Dependabot, gitleaks, husky (öneri olarak, SEC standardında)

## Çalışma süreci

1. **İlgili standardı oku.** İşe başlamadan önce aşağıdaki tablodan işin ilgili olduğu standart dosyasını oku.
2. **Yeni tablo gerekiyorsa önce sor.** Şemaya model eklemeden veya migration oluşturmadan önce DB-13'teki soruları kullanıcıya sor. Cevaplar netleşmeden şemayı değiştirme.
3. **Önce testi yaz.** Yeni bir servis metodu veya uç nokta yazmadan önce testini yaz, başarısız olduğunu gör, sonra kodu yaz (CODE-20).
4. **Teslim etmeden önce kontrol et.** Yazdığın kodu CODE-15 ile CODE-19 arasındaki kurallara ve CODE-21'e göre gözden geçir: tekrar eden kod, SOLID tablosu, karmaşıklık sınırı, strategy kalıbı, sabitler ve gereksiz soyutlama. Ardından `npm run format`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e` ve `npm run docs:check` komutlarını çalıştır.
5. **Standartta olmayan bir karar gerekirse sor.** Dokümanlardaki "Pending proposals" bölümündeki maddeler henüz kural değildir. Bunları kural gibi uygulama.
6. **Standart değişirse dokümanı güncelle.** Kullanıcı bir kuralı değiştirirse ilgili standart dosyasını da güncelle ve bu kurala atıf yapan diğer dosyaları kontrol et.
7. **Yeni uç noktada kontrol listesini uygula.** Yeni bir controller veya uç nokta yazarken, ya da bir uç noktanın davranışını değiştirirken `API_STANDARDS.md` dosyasındaki "New endpoint checklist" adımlarının hepsini uygula. Swagger dokümantasyonu (`@ApiEndpoint`) ve `openapi.json` güncellemesi bu listenin parçasıdır.
8. **Paket eklemeden önce sor.** Yeni bir npm paketi eklemeden önce SEC-04 kontrol listesini doldur ve kullanıcıdan onay al.

## Standart dosyaları

| Dosya | Kimlik | Ne zaman okunur |
|---|---|---|
| `docs/standards/ARCHITECTURE_STANDARDS.md` | ARCH | Yeni modül, yeni klasör veya modüller arası bağımlılık |
| `docs/standards/CODING_STANDARDS.md` | CODE | Her kod değişikliği |
| `docs/standards/DATABASE_STANDARDS.md` | DB | Prisma şeması, migration, sorgu |
| `docs/standards/CACHE_STANDARDS.md` | CACHE | Cache okuma ve yazma |
| `docs/standards/QUEUE_STANDARDS.md` | QUEUE | Kuyruk mesajı, handler, outbox |
| `docs/standards/ERROR_AND_LOGGING_STANDARDS.md` | LOG, ERR | Loglama, hata fırlatma, hata yanıtı |
| `docs/standards/SECURITY_STANDARDS.md` | SEC | Yeni paket, gizli bilgi, uç nokta yanıtı |
| `docs/standards/API_STANDARDS.md` | API | Yeni uç nokta, URL, yanıt biçimi, sayfalama |
| `docs/standards/API_DOCUMENTATION_STANDARDS.md` | DOC | Uç noktanın OpenAPI dokümantasyonu, şema açıklamaları |
| `docs/standards/TESTING_STANDARDS.md` | TEST | Her test yazımı: tür, yer, test verisi, kapsam |

Henüz yazılmayanlar: `COMMIT_STANDARDS.md`. Kullanıcı test kavramlarına yeni, test konusunu jargon kullanmadan ve örneklerle açıkla. Kayıt, giriş ve yetki gibi kullanıcıya bağlı kurallar, o özellik geliştirilirken yazılacak. Bunları önceden tasarlama.

## En sık uygulanan kurallar

Bu liste hatırlatma içindir. Kuralın tamamı ve istisnaları ilgili dosyadadır.

**Yapı**

- Katman yönü: `modules` → `infra` → `core` → `shared`. Bir katman yalnızca alttakileri import eder (ARCH-02).
- Bir modül başka bir modülün yalnızca modülünü (`*.module.ts`), servisini, `.constants.ts` dosyasını, `dto/` ve `messages/` klasörlerini import eder (ARCH-05).
- Bir modül yalnızca kendi tablolarına yazar. Prisma şeması birlikte değişen tablolara göre `prisma/schema/` altında bölünür: `users.prisma`, `jobs.prisma` (ARCH-06).
- `forwardRef` kullanılmaz (ARCH-08). Controller ve handler yalnızca servisi çağırır (ARCH-09).

**İsimlendirme**

- Veritabanı ve mesaj alanları snake_case. DTO, API ve log alanları, değişken, fonksiyon ve metotlar camelCase (CODE-03, API-05).
- Sabit liste değerleri küçük harf (`queued`), hem veritabanında hem API'de (DB-09, API-05). Hata `code` büyük harf, yanıttaki `error` alanı onun küçük harfli hali (ERR-01, ERR-02).
- Sabitler `ORDER_MAX_ITEMS` biçiminde. `as const` listeler PascalCase (`OrderChannel`) (CODE-03, CODE-06).
- İsimler ve yorumlar İngilizce. Yorum yalnızca nedeni anlatır (CODE-04, CODE-05).

**TypeScript**

- `any`, `unknown`, `!` ve TypeScript `enum` kullanılmaz (CODE-06, CODE-08, CODE-09).
- Yalnızca isimli export. Public metotların dönüş tipi yazılır (CODE-07, CODE-10).
- Import'lar `.ts` uzantılı. Klasörler arası `#core`, `#infra`, `#modules` yolları (CODE-13).
- `process.env` yalnızca `src/core/config` içinde okunur (CODE-14).

**Tasarım**

- Fonksiyonda en fazla 9 karar noktası (lint `complexity` 10), 3 seviye iç içe blok, 50 satır (CODE-17).
- Seçenekler açık uçluysa (yeni seçenek beklenir, her birinin kendi bağımlılığı var: AI provider, kuyruk) strategy kalıbı; kapalı bir sonuç listesiyse (`kind` alanlı union) tek `switch` (CODE-18).
- Bugünkü ihtiyaç için en basit çözüm. Tek uygulamalı arayüz ve kullanılmayan seçenek yazılmaz. Benzer kod üçüncü tekrarda ortak koda çıkarılır (CODE-21).
- Anlamı olan metinler sabit olur: sınıfta, `<modül>.constants.ts` veya `<modül>.errors.ts` dosyasında (CODE-19).

**Veri**

- Birincil anahtar UUID v7, zaman damgaları `timestamptz(3)`, kredi tam sayı (`Int`), tutar pozitif ve yönü kaydın tipinden (DB-03, DB-04, DB-06). Zaman karşılaştırmaları veritabanı saatiyle yapılır (DB-21).
- Her ilişkide `onDelete` açıkça yazılır, her foreign key'in index'i vardır (DB-07, DB-08).
- Okuyup değiştiren işler tek bir koşullu ifadeyle yapılır; worker'ın işi lease ve `lock_token` ile korunur (DB-14, DB-15). Bakiye değişikliği ve ledger kaydı aynı transaction'dadır (DB-23).
- Transaction içinde dış servis çağrılmaz (DB-17). Uygulanmış migration değiştirilmez (DB-18).
- Cache'e yalnızca `CacheService` ile erişilir. Doğru kaynak veritabanıdır; cache'teki değer değişmez, yeni sonuç yeni anahtardır (CACHE-01, CACHE-05, CACHE-06).
- Periyodik işler her worker'da çalışır; iki worker'ın aynı işi yapmasını `SKIP LOCKED` ve koşullu güncelleme engeller, her çalışma tekrara dayanıklıdır (QUEUE-14, QUEUE-15).
- Modüller yalnızca kuyruk, AI provider ve dosya deposu portlarını import eder (`#infra/queue/queue.ts`, `#infra/ai-provider/ai-provider.ts`, `#infra/file-store/file-store.ts`); adapter klasörlerini import etmek lint hatasıdır. Kafka kütüphanesi yalnızca `src/infra/queue/kafka` altında kullanılır. Kuyruğa giden mesaj, işle aynı transaction'da outbox'a yazılır; işin durumu `jobs` tablosundadır (QUEUE-01, QUEUE-08, QUEUE-18). Tüketici at-least-once çalışır, handler tekrarı ve sırasızlığı kaldırır (QUEUE-10, QUEUE-19).

**Hata ve log**

- Servisler `src/core/errors` altındaki hata sınıflarını fırlatır, NestJS `HttpException` kullanmaz (ERR-03).
- Hata yanıtları RFC 9457 biçiminde ve `requestId` içerir (ERR-01). Log satırları `requestId` ve worker'da `jobId` taşır; kullanıcının metni ve sonuç loglanmaz (LOG-02, LOG-07).
- `console.log` kullanılmaz. Log mesajı sabit bir olay kodu (`ORDER_CREATED`), veriler ayrı alanlarda (LOG-03).
- Şifre, token, kimlik numarası ve kart bilgisi cache'e, mesaja ve loga açık yazılmaz (CACHE-08, LOG-07).
- Yanıtlar her zaman yanıt DTO'su ile üretilir, Prisma kaydı doğrudan dönülmez (SEC-06).
- Gizli bilgiler koda yazılmaz (SEC-05). Yeni paket eklemeden önce SEC-04 listesini kullanıcıya sun ve onay iste.

## Komutlar

| Komut | İş |
|---|---|
| `npm run start:dev` | Uygulamayı izleme modunda başlatır. |
| `npm run build` | Prisma client'ı üretir ve projeyi derler. |
| `npm run format` | Kodu Prettier ile biçimlendirir. |
| `npm run format:check` | Biçimlenmemiş dosya varsa hata verir. |
| `npm run lint` | oxlint ile lint kontrolü yapar. |
| `npm run typecheck` | Test ve config dosyaları dahil tip kontrolü yapar. Build yalnızca `src` klasörünü kontrol eder. |
| `npm test` | Birim testleri çalıştırır. |
| `npm run test:e2e` | Uç nokta ve veritabanı testlerini (`*.e2e-spec.ts`, `*.db-spec.ts`) test veritabanında çalıştırır. Önce `npm run db:up` gerekir. |
| `npm run test:cov` | Bütün testleri çalıştırır ve %80 kapsam sınırını kontrol eder (TEST-08). |
| `npm run docs:generate` | `docs/api/openapi.json` dosyasını üretir. Uç nokta eklenince veya değişince çalıştır (DOC-06). |
| `npm run docs:check` | `openapi.json` güncel değilse veya belgelenmemiş uç nokta varsa hata verir. |
| `npm run prisma:migrate` | Geliştirme ortamında migration oluşturur ve uygular. |
| `npm run prisma:deploy` | Bekleyen migration'ları uygular, yeni dosya oluşturmaz. |
| `docker compose up -d --build` | Önce migration'lar (`migrate` servisi), sonra uygulama, worker, veritabanı, Redis ve Kafka. Yerel `npm run start:dev` ile aynı anda çalıştırma, ikisi aynı portu kullanır. |
| `npm run db:up` | Yalnızca veritabanı, Redis ve Kafka. Uygulama yerelde `npm run start:dev` ile çalışırken kullanılır. |
| `docker compose run --rm seed` | Bir kullanıcıya 500.000 iş üretir (EXPLAIN ANALYZE ve CSV kontrolü için, yaklaşık 2 dakika). Yeniden çalıştırılınca seed verisini baştan kurar. |
| `docker compose run --rm test` | Birim testlerini, sonra uç nokta ve veritabanı testlerini Docker içinde çalıştırır (Node gerekmez). Compose'daki PostgreSQL ve Redis'i kullanır, ama ayrı test veritabanı ve Redis DB 1 ile; çalışan stack'in verisine dokunmaz. |
| `docker compose run --rm verify all` | `scripts/verify.sh` ile aynı kontroller, bir container içinde (yalnızca Docker gerekir; container Docker soketini kullanır, worker'ı durdurmak ve log ile belleği okumak için). |
| `scripts/verify.sh` | Case'in doğrulama akışını çalışan stack'e karşı adım adım kontrol eder ve her adımın sonucunu ✔/✘ ile yazar. `--help` kontrolleri listeler; `all` dışa aktarma hariç hepsini, `export` 500.000 işlik CSV kontrolünü çalıştırır. |

## Teknoloji

NestJS 12, TypeScript 6 (ESM, `nodenext`), Node.js 24 (`.nvmrc`, `engines` ve `engine-strict` ile sabit; Docker imajı 24.22.2; komutlardan önce `nvm use`), Prisma 7.10.1 (`@prisma/adapter-pg`), PostgreSQL 17.11, Redis 7.4.12 (ioredis), Kafka 4.1.0 (`@confluentinc/kafka-javascript`), zod 4, Vitest 4, oxlint. Paket yöneticisi npm.
