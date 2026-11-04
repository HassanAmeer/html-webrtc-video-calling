# E2E Test Infra: VRemote WebRTC Hardening

## Test Philosophy
- Opaque-box, requirement-driven. Derived strictly from `ORIGINAL_REQUEST.md` and user-facing specifications.
- Methodology: Category-Partition + Boundary Value Analysis (BVA) + Pairwise Combinatorial Testing + Workload Testing.

## Feature Inventory
| # | Feature | Source | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|---------|--------|:------:|:------:|:------:|:------:|
| F1 | Accessibility Status Check | ORIGINAL_REQUEST R1 | 5 | 5 | ✓ | ✓ |
| F2 | Accessibility Dialog Permanent Suppression | ORIGINAL_REQUEST R1 | 5 | 5 | ✓ | ✓ |
| F3 | Android 8 Permissions Detection | ORIGINAL_REQUEST R2 | 5 | 5 | ✓ | ✓ |
| F4 | Web 8 Permissions Detection | ORIGINAL_REQUEST R2 | 5 | 5 | ✓ | ✓ |
| F5 | Real-Time Active Permissions UI | ORIGINAL_REQUEST R2 | 5 | 5 | ✓ | ✓ |
| F6 | Unattended Background Command Handling | ORIGINAL_REQUEST R3 | 5 | 5 | ✓ | ✓ |
| F7 | Suppression of Force-Launch Phone UI | ORIGINAL_REQUEST R3 | 5 | 5 | ✓ | ✓ |
| F8 | Live Runtime Logging Across Full Stack | ORIGINAL_REQUEST R3 | 5 | 5 | ✓ | ✓ |
| F9 | Security PIN Auto-Unlock Prevention | ORIGINAL_REQUEST R4 | 5 | 5 | ✓ | ✓ |
| F10 | Strict 1200ms Hold-To-Unlock Flow | ORIGINAL_REQUEST R4 | 5 | 5 | ✓ | ✓ |

## Test Architecture
- **Runner**: Node.js native test runner (`node --test tests/e2e_runner.test.js`) and automated verification scripts.
- **Test Categories**:
  - `tests/unit_security.test.js`: PIN input validation, hold-timer logic, shake error, rejection of auto-login on typing.
  - `tests/unit_permissions.test.js`: Web Permissions API queries, socket status, camera/mic label detection, real-time UI transitions.
  - `tests/unit_accessibility.test.js`: Android Settings.Secure query logic, SharedPreferences persistence contract, dialog suppression rules.
  - `tests/unit_background_logging.test.js`: Server routing of auto-commands, log buffer ingestion and retrieval (`/api/logs`), headless execution integrity.
  - `tests/e2e_integration.test.js`: Full end-to-end integration across signaling server, web client, and simulated Android client.

## Test Tier Minimum Thresholds
- N = 10 features (F1 - F10)
- Tier 1: ≥ 5 × 10 = 50 test cases (Feature coverage happy path)
- Tier 2: ≥ 5 × 10 = 50 test cases (Boundary, edge, error conditions)
- Tier 3: ≥ 10 test cases (Pairwise cross-feature interactions)
- Tier 4: ≥ 5 realistic application scenarios (Real-world workloads)
- Tier 5: Adversarial white-box coverage hardening

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Unattended Video Call to Closed App | F6, F7, F8 | High |
| 2 | Gallery Remote Browsing in Background | F6, F7, F8 | Medium |
| 3 | Side Sheet Permissions Inspection & Live Granting | F3, F4, F5 | Medium |
| 4 | Cold Launch Accessibility Check & Suppression | F1, F2, F8 | Medium |
| 5 | Unauthorized Lock Screen Tampering & Secure Unlock | F9, F10 | Medium |
