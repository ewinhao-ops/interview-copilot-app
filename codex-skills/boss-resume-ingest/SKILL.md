---
name: boss-resume-ingest
description: Use when Codex needs to collect candidate resume information from the BOSS Zhipin web frontend, sanitize private data, normalize the candidate into structured JSON, and ingest it into the Interview Workbench through its API or Feishu transition scripts. This skill is a desensitized template for browser-assisted BOSS resume acquisition and must be customized with the user's own compliance rules, field mapping, and access tokens before use.
---

# BOSS Resume Ingest

This desensitized skill guides Codex through collecting a candidate resume from the BOSS Zhipin web frontend and importing it into the Interview Workbench.

## Non-Negotiables

- Operate only on accounts, roles, pages, and candidates the user is authorized to access.
- Do not bypass platform controls, paywalls, rate limits, login checks, anti-bot checks, or access restrictions.
- Do not scrape in bulk. Process one visible candidate conversation or resume page at a time unless the user provides a compliant export.
- Do not store raw screenshots, page dumps, cookies, tokens, phone numbers, WeChat IDs, or platform identifiers in the repository.
- Redact or omit sensitive personal data unless the user explicitly needs it for the recruiting workflow and the target system is private.
- If a page contains private or irrelevant messages, extract only the resume and recruiting decision fields needed by the workbench.

## Required Setup

Before using this skill, confirm:

1. The workbench is running locally or remotely.
2. `INGEST_TOKEN` is configured if using `POST /api/candidates`.
3. The user is logged in to BOSS Zhipin in a browser they authorize Codex to control.
4. The user has chosen whether to ingest into SQLite directly through the API or into the legacy Feishu bridge script.

## Desensitization Rules

Use these default redactions unless the user's private deployment requires the original values:

- Name: keep display name if needed for recruiting, otherwise replace with `候选人A`.
- Phone, WeChat, email, ID numbers: omit or replace with `[REDACTED_CONTACT]`.
- Company names from prior employers: keep only when relevant to experience assessment; otherwise replace with `某公司`.
- School names: keep education level and major; redact school name if not necessary.
- URLs, attachments, cloud-drive links: store as `[REDACTED_LINK]` unless already approved for the private system.
- Chat timestamps and message metadata: omit unless they affect next-step timing.
- Salary expectations and city preferences: keep only as normalized fields such as `expectedSalaryRange` and `expectedCity`.
- Internal company names, Feishu base URLs, tenant IDs, app tokens, table IDs, local paths, and operator names: never hard-code in public files.

## Workflow

1. Open the authorized BOSS page in the user's browser.
2. Identify the current candidate and role being processed.
3. Extract visible resume facts:
   - `bossName`
   - `name` if explicitly available and allowed
   - `role`
   - `currentLocation`
   - `collectedDate`
   - `basicInfo`
   - `jobIntent`
   - `workHistory`
   - `projectHistory`
   - `education`
   - `skills`
   - `works`
   - `selfDescription`
   - `contactClues`
   - `salaryLocationAvailability`
   - `nextStep`
4. Normalize the result into JSON. Keep long resume text under `resumeText` only after applying redaction.
5. Ask for confirmation before writing if the user has not already authorized ingestion.
6. Ingest through one of these paths:
   - Preferred: `POST /api/candidates` with `Authorization: Bearer $INGEST_TOKEN`.
   - Legacy bridge: `node scripts/upsert-boss-resume-to-feishu-library.mjs --write --json '<json>'`.
7. Verify the candidate appears in the workbench and report the created/updated candidate name, role, and next step.

## API Ingest Shape

Use this shape for the preferred API path:

```json
{
  "bossName": "候选人A",
  "name": "候选人A",
  "role": "AI应用工程师",
  "currentLocation": "城市",
  "collectedDate": "YYYY-MM-DD",
  "resumeText": "脱敏后的简历摘要",
  "source": "BOSS",
  "invitationStatus": "uninvited",
  "currentStage": "intake"
}
```

Send it with:

```bash
curl -X POST "$WORKBENCH_URL/api/candidates" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  --data @candidate.json
```

## Quality Bar

Before finishing, check:

- The candidate has no raw phone, WeChat, email, ID number, token, cookie, or private URL in files intended for GitHub.
- The JSON contains enough evidence for AI screening to generate a useful assessment.
- The role is normalized to the workbench's position taxonomy.
- The next action is explicit: wait, request material, invite async interview, schedule second interview, or reject.
- The user can reproduce the workflow from the written steps without relying on hidden local files.
