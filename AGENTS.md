# AGENTS.md — J&H LLC Project Context & Architecture Guidelines

## Brand Architecture & Hierarchy

```
J&H LLC (Parent Entity)
├── J&H Land Services LLC
│   ├── Public Services Catalog & Request Quote
│   └── Client Portal (Service Requests, Invoices, Job Tracking)
│
└── Training Programs (B2B Commercial Learning Platform)
    ├── Organization Training Catalog (Isolated Private Client Portals)
    │   ├── J&H Land Services (Primary Operating Organization Portal)
    │   └── Private Client Portals (On-Demand Provisioned Enterprise Portals)
    │
    └── Training Studio Engine (9-Step Training Program Wizard & Curriculum Builder)
```

## Functional Principles

1. **Brand Separation**:
   - `J&H Land Services LLC` represents professional land development, forestry mulching, excavation, and property maintenance services.
   - `Training Programs` represents a multi-tenant B2B Learning Management System (LMS) where external businesses and internal teams host private employee portals.

2. **Organization Portal Privacy ("Everything is Visible, Nothing is Accessible")**:
   - The public Organization Training Catalog showcases all active client portals.
   - Access to course materials within any portal requires authentication. Unauthenticated users clicking on a private portal card are presented with an authentication modal informing them that the portal is restricted to authorized employees.

3. **Training Program Wizard (9 Steps)**:
   - Admins/Owners build and publish curricula using a 9-step wizard:
     1. Program Information
     2. Knowledge Sources
     3. Learning Objectives
     4. Program Structure & Modules
     5. Lessons & Content
     6. Assessments & Quizzes
     7. Practical Field Evaluations
     8. Certification & Expiration
     9. Review & Compilation
