# Domain Label Catalogue

Suggested labels MUST come from this list. Inferring the primary domain from the affected files is your strongest signal — `src/<top-level>/...` directly maps to most labels.

| Label | Scope | Typical paths |
|---|---|---|
| `domain/checkout` | Cart, order placement, payment, shipping | `src/Core/Checkout/` |
| `domain/storefront` | Twig templates, Bootstrap, customer-facing UI | `src/Storefront/` |
| `domain/admin` | Vue admin panel, settings | `src/Administration/` |
| `domain/framework` | DAL, events, plugin lifecycle, kernel | `src/Core/Framework/`, `src/Core/System/` |
| `domain/b2b` | B2B suite, quotes, org units | `src/Commercial/B2B/` |
| `domain/crm-after-sales` | Customer, address, after-sales flows, import/export, mail | `src/Core/Content/ImportExport`, `src/Core/Content/Mail`, customer-related |
| `domain/inventory` | Product, stock, bundles | `src/Core/Content/Product/` |
| `domain/discovery` | CMS, search, content, page builder, media | `src/Core/Content/Cms/`, `src/Core/Content/Media/` |
| `domain/content` | Mail templates, generic content | content-area shared |
| `domain/search` | Elasticsearch, indexing | `src/Elasticsearch/` |
| `domain/commercial` | Rule builder, flow builder (paid) | `src/Commercial/` |
| `domain/migration` | Migration assistant | migration-related |
| `domain/api` | Admin API, Store API, Sync API | `src/Core/Framework/Api/` |
| `domain/service-enablement` | Webhooks, integrations | webhook/integration paths |

**Use 1–2 labels.** Prefer the primary surface area (where the user observes the bug). If you genuinely can't choose, pick the one that matches the deeper layer of the stack (DAL/framework over UI).
