# AI recruitment workflow template

Sanitized n8n template for a multilingual recruitment workflow. It accepts CRM chat events, maintains conversation state, processes candidate documents, and updates the CRM with structured notes and qualification results.

## Architecture

```text
CRM / WhatsApp -> n8n webhook -> AI agent -> Supabase conversation state
                                  |-> Google Drive candidate files
                                  |-> CRM replies, notes, and lead updates
```

## Included capabilities

- Pipeline-aware KZ and RU recruitment scenarios
- Persistent conversation history and session state in Supabase
- CV, image, voice, video, and document-processing branches
- Structured CRM notes and qualification transitions
- LLM response validation and fallback configuration

## Use the template

1. Import `workflow.template.json` into a non-production n8n instance.
2. Create your own credentials for the CRM, Supabase, Google Drive, and LLM provider.
3. Replace every `YOUR_*` value with IDs and URLs from your own environment.
4. Configure incoming-chat routing in your CRM before enabling the workflow.
5. Test with synthetic leads and documents before using real candidate data.

## Security and privacy

This repository intentionally excludes production credentials, webhook paths, CRM IDs, drive IDs, account names, candidate data, and real vacancy links. Do not add production exports, execution data, resumes, chat logs, or `.env` files to version control.

