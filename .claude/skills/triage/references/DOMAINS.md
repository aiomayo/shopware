# Domain Label Catalogue

Suggested labels MUST come from this list. Inferring the primary domain from the affected files is your strongest signal — `src/<top-level>/...` directly maps to most labels.

Domain labels are **team-ownership** labels — each one names the team responsible for that surface area, not a code path. Most have an obvious `src/` mapping, some don't (`domain/ux`, `domain/dx-tools`, `domain/*-ops`).

| Label | Team scope | Typical paths / signals |
|---|---|---|
| `domain/b2b` | B2B functionalities | `src/Commercial/B2B/`, quote-management, organisation-units, order-approvals |
| `domain/checkout` | The buying transaction (cart → payment → order placement) | `src/Core/Checkout/`, `component/cart`, `component/payments`, `component/shipping`, `component/promotions`, `component/tax` |
| `domain/crm-after-sales` | After-checkout flows (orders, customers, mail, import/export) | `src/Core/Content/Mail`, `src/Core/Content/ImportExport`, `component/orders`, `component/customers`, `component/mailer` |
| `domain/discovery` | Shopper-facing discovery (CMS, search, content, page builder, media) | `src/Core/Content/Cms/`, `src/Core/Content/Media/`, `src/Elasticsearch/`, `component/search`, `component/shopping-experiences`, `component/seo` |
| `domain/dx-tools` | Developer-experience tooling | CLI, scaffolders, dev containers, IDE tooling |
| `domain/framework` | Framework-level code: core, administration UI, storefront UI, Admin/Store/Sync APIs | `src/Core/Framework/`, `src/Core/System/`, `src/Administration/`, `src/Storefront/`, `src/Core/Framework/Api/`, `component/administration`, `component/storefront`, `component/core` |
| `domain/inventory` | Products and everything product-related | `src/Core/Content/Product/`, `component/inventory-*`, `component/categories` |
| `domain/product-ops` | Product Operations (release cadence, roadmap process) | non-code, process issues |
| `domain/quality-ops` | Quality Operations (test infrastructure, flaky-test triage) | `component/e2e-playwright`, CI workflows, test-runner issues |
| `domain/service-enablement` | Supporting Shopware-platform services (webhooks, integrations, app system) | `component/appsystem`, `component/extension-store`, `component/appstore`, webhook/integration paths |
| `domain/ux` | User-experience topics across the suite | cross-cutting UI/UX concerns, accessibility-adjacent |

**Use 1–2 labels.** Prefer the primary surface area (where the user observes the bug). If you genuinely can't choose between an ownership team and a code area, pick the ownership team that would route to the right backlog.

When a single issue spans two domains (e.g. checkout UI bug → both `domain/checkout` and `domain/framework`), pick the team that owns the **fix**, not the symptom.

Deprecated and excluded from this list: **domain/customer-support** (per Terraform: use the standalone `customer-support` label instead).
