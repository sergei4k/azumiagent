/**
 * Extract text from resume files (PDF, DOCX) and generate a short summary for amoCRM notes.
 */

import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';

const MAX_TEXT_FOR_SUMMARY = 12000; // chars to send to LLM
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

/**
 * Fetch file from URL and return as ArrayBuffer.
 */
async function fetchFile(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Failed to fetch resume: ${res.status}`);
  return res.arrayBuffer();
}

/**
 * Extract plain text from a resume file (PDF or DOCX).
 */
export async function extractResumeText(
  fileUrl: string,
  mimeType?: string,
  fileName?: string
): Promise<string> {
  const buffer = await fetchFile(fileUrl);
  const arr = new Uint8Array(buffer);

  const isPdf =
    mimeType === 'application/pdf' ||
    fileName?.toLowerCase().endsWith('.pdf');

  const isDocx =
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/msword' ||
    /\.(docx?|doc)$/i.test(fileName || '');

  if (isPdf) {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const text = result?.text?.trim() || '';
      await parser.destroy();
      return text;
    } catch (e) {
      await parser.destroy().catch(() => {});
      throw e;
    }
  }

  if (isDocx) {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(arr) });
    return (result.value || '').trim();
  }

  throw new Error('Unsupported resume format. Use PDF or DOCX.');
}

/**
 * Summarize resume text using Gemini. Returns a short paragraph suitable for a CRM note.
 */
export async function summarizeResumeText(rawText: string): Promise<string> {
  if (!rawText || rawText.length < 20) return '';

  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (!apiKey) {
    console.warn('GOOGLE_GENERATIVE_AI_API_KEY not set, skipping resume summary');
    return '';
  }

  const text = rawText.length > MAX_TEXT_FOR_SUMMARY
    ? rawText.slice(0, MAX_TEXT_FOR_SUMMARY) + '\n[... truncated]'
    : rawText;

  const prompt = `You are summarizing a candidate's resume for a nanny/governess recruitment CRM. Write a short summary in English (2–4 sentences) covering:
- Main profession and years of experience if mentioned
- Key qualifications (education, certifications, languages)
- Relevant childcare or teaching experience if any
- Current location or willingness to relocate if stated

Keep the tone neutral and factual. Output only the summary, no headings or labels.`;

  try {
    const res = await fetch(`${GEMINI_API}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Resume text:\n\n${text}\n\n${prompt}` }] }],
        generationConfig: {
          maxOutputTokens: 300,
          temperature: 0.3,
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn('Gemini summary API error:', res.status, err);
      return '';
    }

    const data = await res.json();
    const part = data?.candidates?.[0]?.content?.parts?.[0];
    const summary = part?.text?.trim();
    return summary || '';
  } catch (e) {
    console.warn('Resume summary failed:', e);
    return '';
  }
}

/**
 * Fetch resume from URL, extract text, and return an LLM-generated summary.
 * Returns empty string on any error (log and continue).
 */
export async function getResumeSummary(
  fileUrl: string,
  mimeType?: string,
  fileName?: string
): Promise<string> {
  try {
    const text = await extractResumeText(fileUrl, mimeType, fileName);
    if (!text) return '';
    return await summarizeResumeText(text);
  } catch (e) {
    console.warn('Could not generate resume summary:', e);
    return '';
  }
}
