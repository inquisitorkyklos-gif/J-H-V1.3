# Project Status

## Organization
**Parent Brand:** J&H

**Current Operating Company:**
J&H Land Services LLC

## Current Version
Beta 1.0

## Authoritative Source
This document is the single source of truth for the J&H ecosystem. All AI assistants, developers, and future team members should treat this document as the authoritative reference.

## Last Updated
2026-07-20

## Current Deployment
Production (Netlify)

## Current Priorities
1. Position J&H Land Services LLC as the first business operating under the J&H umbrella.
2. Maintain high-fidelity responsive UI with strict, senior-friendly readability standards.
3. Protect company profitability by quoting solely through custom site walkthrough estimates.
4. Continue improving the admin portal and internal business management tools.
5. Build a professional customer acquisition system (SEO, lead capture, quote requests, contact flow).

## Long-Term Vision
J&H will serve as the parent brand for multiple business ventures. J&H Land Services LLC is the first operating company. The website, software architecture, and administrative tools should be designed from the beginning to support additional J&H businesses without requiring a complete redesign.

---

## 1. Project Identity

* **App Name**: J&H Parent Portal
* **Industry**: Parent brand for Land Clearing, Excavation, Forestry Mulching, and Professional Operator Training Systems.
* **Target Audience**: Northern Neck of Virginia landowners, seasonal/second-home owners, commercial operators, and J&H operational staff.
* **Company Contact Details**:
  * **Phone**: (804) 761-0096
  * **Email**: jandhllc20@gmail.com
  * **Region**: Montross, Neenah, King George County, Westmoreland County, and the broader Northern Neck area of Virginia
* **Primary Solutions & Services**:
  1. **Property Management Care & Upkeep**: Routine exterior/interior checks and maintenance coordination for second homes.
  2. **Seasonal Home Opening & Winterization**: Utility safing, line draining, and winter prep for seasonal residents.
  3. **Land Clearing & Forestry Mulching**: Eco-friendly underbrush clearing, trails, and boundary reclaiming.
  4. **Excavation & Demolition**: Site prep, grading, utilities trenching, and light structural demounting.
  5. **Gravel Driveways & Driveway Repair**: Resurfacing, crowning, potholes correction, side ditching, and culvert installation.
  6. **Exterior Property Maintenance & Cleanup**: Power/soft-washing of siding, gutter clearing, and storm debris hauling.
  7. **Specialty Projects**: Managed subcontractor coordination.

---

## 2. Technology Stack

* **Hosting**: Netlify Serverless Cloud Platform
* **Frontend Framework**: React 19 (via Vite 6)
* **Backend Runtime**: Node.js / Express 4 (run Serverless via `serverless-http` in production)
* **Language**: TypeScript / JavaScript
* **Database & Storage (Hybrid Persistence)**:
  * **Production**: Netlify Blobs Object Storage (via `@netlify/blobs`)
  * **Development**: Local JSON-based persistent file storage (`leads_db.json`)
* **Key Packages & Dependencies**:
  * `@google/genai` (^2.4.0): Dynamic Gemini 3.5 AI model integration (server-side only)
  * `@netlify/blobs` (^10.7.9): Durable cloud key-value store for Netlify
  * `jspdf` (^4.2.1) & `jspdf-autotable` (^5.0.8): Visual, brand-conforming PDF estimate generator
  * `lucide-react` (^0.546.0): Universal vector icon library
  * `motion` (^12.23.24): Smooth layout transitions and staggered micro-animations
  * `dotenv` (^17.2.3): Production environment management
  * `esbuild` (^0.25.0): Backend TypeScript bundling compiler
* **Environment Variables**:
  * `GEMINI_API_KEY`: Server-side API key for the Gemini model (never exposed to client)
  * `NETLIFY` / `NETLIFY_IMAGES_CDN_DOMAIN`: Used by the dynamic persistence layer to detect Netlify and route to Blob storage

---

## 3. Complete File Structure

Below is the exhaustive layout of the workspace, including a detailed functional description for each module:

```
├── .env.example                     # Reference file for environment configuration (e.g., GEMINI_API_KEY)
├── .gitignore                       # Explicit build, cache, and DB file ignore rules
├── PROJECT_CONTEXT.md               # [THIS FILE] Master architecture and reference manual
├── dev-server.ts                    # Vite dev server utility for running port 3000 in workspace
├── index.html                       # Base HTML mounting shell for React
├── metadata.json                    # Application metadata, descriptions, and capabilities for AI Studio
├── netlify.toml                     # Production serverless routing, rewrite rules, and build scripts
├── package.json                     # Root configuration for scripts, dependencies, and bundlers
├── tsconfig.json                    # TypeScript compiler parameters and options
├── vite.config.ts                   # Vite compilation setup integrated with Tailwind CSS
├── server.ts                        # Full-stack Express server handling API endpoints and security
├── netlify/
│   └── functions/
│       └── api.ts                   # Netlify serverless wrapper deploying Express via serverless-http
└── src/
    ├── main.tsx                     # React client runtime initializer
    ├── index.css                    # Global styling imports (Tailwind CSS) and Senior Mode fonts rules
    ├── App.tsx                      # Primary controller managing page routing, state, and Senior Mode
    ├── data.ts                      # Shared static metadata (Company Info, Services definitions, FAQs)
    ├── pricingData.ts               # Core rate schedules, multipliers, and calculation engine
    ├── types.ts                     # Exhaustive TypeScript interface definitions
    ├── services/
    │   └── dataService.ts           # Dynamic DAO persistence engine (Local JSON ⇆ Netlify Blobs)
    ├── utils/
    │   └── api.ts                   # Safe client fetch wrappers handling server responses
    └── components/
        ├── Header.tsx               # Primary site navigation bar with Senior Mode toggle
        ├── Hero.tsx                 # Branding header with high-contrast accessibility buttons
        ├── Services.tsx             # Interactive grid showcase of solutions and features
        ├── QuoteForm.tsx            # Full customer inquiry form with firewood calculator
        ├── AIConsultant.tsx         # AI-powered land project consultant (Gemini API ⇆ fallbacks)
        ├── CustomerPortal.tsx       # Live status tracker for clients matching by phone number
        ├── BusinessWorkspace.tsx    # Secure admin dashboard (Leads, Tasks, Inventory, Notes, PDF Gen, and TrainingManager)
        ├── Training.tsx             # Public training division landing page (secured via staff bypass check)
        ├── Testimonials.tsx         # Customer reviews carousel
        ├── TrustFAQ.tsx             # Operational FAQs and answers to build customer confidence
        └── training/
            └── TrainingManager.tsx  # Secure, content-agnostic J&H operator training management system
```

---

## 4. Data Models & Types

Key interface declarations from `/src/types.ts`:

### Lead Schema
```typescript
export interface Lead {
  id: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  serviceType: string;
  details: string;
  firewoodDetails?: {
    woodType: string;
    quantity: number;
    deliveryNeeded: boolean;
    estimatedCost: number;
  };
  aiRecommendation?: string;
  status: "new" | "under_review" | "contacted" | "approved" | "scheduled" | "declined" | string;
  createdAt: string;
  notes?: string;
  estimate?: {
    services: string[];
    estimatedLow: number;
    estimatedHigh: number;
    briefBreakdown: string;
  };
}
```

### Logistics Task Schema
```typescript
export interface Task {
  id: string;
  title: string;
  assignedTo: "Admin" | "Employee";
  priority: "low" | "medium" | "high" | "critical";
  status: "pending" | "in_progress" | "completed";
  dueDate: string;
  notes: string;
}
```

### Equipment & Materials Inventory Schema
```typescript
export interface InventoryItem {
  id: string;
  name: string;
  category: "Materials" | "Equipment Hours" | "Supplies";
  quantity: number;
  unit: string;
  status: "In Stock" | "Low Stock" | "Out of Stock" | "Operational" | "Maintenance Required";
  lastUpdated: string;
}
```

### Shared Corporate Notes & Version Schema
```typescript
export interface NoteAttachment {
  name: string;
  type: string; // "photo" | "pdf" | "estimate" | "invoice" | "permit" | "contract" | "other"
  url?: string;
  size?: string;
  uploadedAt: string;
}

export interface NoteVersion {
  id: string;
  content: string;
  title: string;
  editedBy: string;
  editedAt: string;
}

export interface MeetingNote {
  id: string;
  title: string;
  content: string;
  date: string;
  department: string;
  project: string;
  customer: string;
  serviceCategory: string;
  isPinned: boolean;
  isArchived: boolean;
  createdBy: string;
  lastEditedBy: string;
  lastEditedAt: string;
  attachments: NoteAttachment[];
  versions: NoteVersion[];
}
```

---

## 5. API Endpoints

All endpoints are hosted relative to `/api/*` and map server-side logic in `/server.ts`:

| Method | Endpoint | Request Body | Response Shape | Middleware / Description |
| :--- | :--- | :--- | :--- | :--- |
| **POST** | `/api/leads` | Partial Lead object (excluding ID) | `{ success: true, lead: Lead }` | Public. Captures an inquiry, calculates initial price estimates, appends mock AI recommendations, and persists it. |
| **POST** | `/api/customer/login` | `{ email?: string, phone: string }` | `{ success: true, leads: Lead[] }` | Public. Matches clean digits of a client's phone number to return their respective project submissions. |
| **POST** | `/api/auth/login` | `{ username, password }` | `{ success: true, token, role, user }` | Public. Validates staff credentials. Computes SHA-256 password hash on incoming data. |
| **GET** | `/api/leads` | None | `Lead[]` | `verifyAuth`. Fetches all captured leads. |
| **PATCH** | `/api/leads/:id` | `{ status, notes, estimate, ... }` | `{ success: true, lead: Lead }` | `verifyAuth`. Updates a lead's status, notes, or estimates. |
| **DELETE** | `/api/leads/:id` | None | `{ success: true }` | `verifyAuth`. Securely drops a lead record. |
| **GET** | `/api/tasks` | None | `Task[]` | `verifyAuth`. Fetches staff tasks. |
| **POST** | `/api/tasks` | `Task` object | `Task` | `verifyAuth`. Adds a new logistics task. |
| **PATCH** | `/api/tasks/:id` | Partial Task object | `Task` | `verifyAuth`. Updates status or notes on a task. |
| **DELETE** | `/api/tasks/:id` | None | `{ success: true }` | `verifyAuth`. Drops a task. |
| **GET** | `/api/inventory` | None | `InventoryItem[]` | `verifyAuth`. Fetches materials and equipment. |
| **POST** | `/api/inventory` | `InventoryItem` | `InventoryItem` | `verifyAuth`. Adjusts or logs materials count. |
| **GET** | `/api/analytics` | None | Analytics payload | `verifyAuth`. Returns financial pipelines and status metrics. |
| **POST** | `/api/gemini/consult` | Consultation State | Consultation report text & raw estimate | Public. Proxies to Gemini 3.5 AI, locking it to pricing schedules, with seamless fallback logic. |
| **GET** | `/api/notes` | None | `MeetingNote[]` | `verifyAuth`. Returns staff notes. |
| **POST** | `/api/notes` | `MeetingNote` | `MeetingNote` | `verifyAuth`. Creates a new knowledge base item. |
| **PATCH** | `/api/notes/:id` | Partial Note | `MeetingNote` | `verifyAuth`. Updates note content, tracking previous changes in `versions`. |
| **DELETE** | `/api/notes/:id` | None | `{ success: true }` | `verifyAuth`. Deletes a note. |
| **POST** | `/api/notes/:id/attachments` | `{ name, type }` | `{ success: true, attachment }` | `verifyAuth`. Adds a mock attachment reference. |
| **POST** | `/api/assistant/chat` | `{ query, chatHistory }` | `{ text }` | `verifyAuth`. Core Operations AI Assistant utilizing rich database context parameters. |

---

## 6. Business Logic & AI Price Lock

To guarantee that the AI Property Consultant does not overstate or misquote, a rigid mathematical rate lock structure is implemented in `/src/pricingData.ts`:

### Price Rules Matrix (PRICING_DATA)
* **Property Management Care**: Base $150. Multipliers apply per size (up to 4.0x for 20+ acres) and terrain (up to 1.3x for wet/swampy conditions).
* **Seasonal Home opening/Winterization**: Base $250.
* **Land Clearing & Forestry Mulching**: Base $1,200 (forestry mulcher operations).
* **Excavation & Demolition**: Base $800.
* **Gravel Driveways**: Base $600.
* **Exterior Property Maintenance**: Base $200 (soft-washing and power washing).

### Pricing Calculations Formula (`calculateEstimate`)
$$\text{Calculated Base} = \text{Base Price} \times \text{Size Multiplier} \times \text{Terrain Multiplier}$$
* **Low Estimate Range**: $85\%$ of Calculated Base.
* **High Estimate Range**: $120\%$ of Calculated Base.
* **Expedited operations premium**: Adds $+10-15\%$ to final values if terms like `urgent` or `ASAP` are detected in specifications.
* **Complex environmental logistics premium**: Adds $+15-25\%$ if terms like `steep`, `rock`, or `swamp` are detected.

### The AI Consultant Lock
The `/api/gemini/consult` endpoint intercepts user specifications and computes the physical rates first using the static `calculateEstimate` routine. The resulting mathematical breakdown is injected into a strict system-level prompt as a structured context section (`### 💰 ESTIMATED COST ESTIMATE (AI CONSULTANT)`). The AI is strictly forbidden from editing these rates, ensuring absolute brand compliance and consistent quoting parameters.

---

## 7. Feature Summary

* **Dynamic Customer Portal**: Lets clients view live statuses (`Inquiry Logged`, `Under Review`, `Approved / Scheduled`, `Declined`) matching exact digit sequences in phone numbers.
* **Brand-Aligned PDF Quote Builder**: Generates clean, physical quotes with Forestry/Earth-toned styling elements (such as Forest Green `#2F5D3A` header blocks, corporate metadata panels, signature lines, and auto-table layouts) matching estimates perfectly.
* **Senior Reading Mode Accessibility**: Activates high-contrast outlines, overrides font constraints to clear serif configurations, and introduces larger click areas.
* **Corporate Operations Assistant**: A private chatbot giving staff immediate, contextual summaries, invoice calculations, subcontractor agreements, or crew schedules by parsing raw logs of the active database.
* **Search, Sort, & Filter Rails**: Full staff sorting capabilities (Client Name, Date Created, custom statuses like "Under Review") inside the Dispatch board.

---

## 8. Known Constraints & Blockers

* **Email Dispatch Integration**: Blocked/Stubbed. Automated receipts are disabled in development to prevent third-party failures; the system displays informative user alerts advising that physical logs have been verified.
* **Phase 2 Migration Strategy**: System architecture is organized cleanly to allow transition from ephemeral in-memory variables and local JSON files directly to enterprise databases (e.g., PostgreSQL / Firestore) without modifying component lifecycles.

---

## 9. Key Architectural Decisions

1. **Robust Client Error Catching**: Client-side fetch utilities in `src/utils/api.ts` verify header types, intercepting default HTML routing fallbacks (e.g., 404 sheets) to prevent raw JSON parsing failures.
2. **Abstractions Layer (DAO Pattern)**: File storage is isolated inside `/src/services/dataService.ts`. The main server and components never reference the disk directly, making database migrations effortless.
3. **No Key Leakage Policy**: Client components utilize backend endpoints exclusively to perform AI processing, guarding developer secrets from external browsers.
4. **No Public Flat Rates**: To protect business margins from operational variables (e.g., equipment renting, transport, and site difficulty), all flat-rate packages, half-day/full-day numbers, and pricing configurators are removed from public pages. Instead, public users are driven to a risk-free "Free Property Walkthrough" & detailed custom written quote funnel.
5. **Robust Responsive Component Layout**: Key Call-to-Action groupings (like the primary and secondary call buttons in the Hero) are configured using CSS Grid elements. This avoids overlapping, enforces identical sizing, supports graceful text wrapping for longer phone strings, and smoothly wraps to single-column vertical stacks on mobile sizes.

---

## 10. Deployment Configuration

* **Redirect Rules (`netlify.toml`)**:
  * `/api/*` proxies cleanly to the serverless function `/.netlify/functions/api/:splat`.
  * `/*` routes back to `index.html` to support smooth React client-side SPAs.
* **Build System Commands**:
  * **Compile Command**: `npm run build`
  * **Bundle Tooling**: Vite parses and compiles frontend static assets into `/dist`, while `esbuild` bundles the Express server structure into a self-contained CommonJS output (`dist/server.cjs`), bypassing ES Module runtime conflicts.
