import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createCandidateLead } from '../integrations/amocrm';
import { getFileUrl } from '../integrations/telegram-client';
import { fileStoreByPhone } from '../integrations/shared-file-store';

// In-memory candidate store (in production, replace with database/CRM lookup)
// This simulates a database of existing candidates
interface StoredCandidate {
  applicationId: string;
  fullName: string;
  phone: string;
  email?: string;
  status: 'pending' | 'in-review' | 'interview-scheduled' | 'documents-pending' | 'matched' | 'placed' | 'rejected' | 'inactive';
  appliedAt: string;
  lastContactAt: string;
  notes?: string;
}

// Simulated database - in production, this would be your actual DB/CRM
const candidateStore: Map<string, StoredCandidate> = new Map();

// Helper to normalize phone numbers for comparison
function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\(\)\.]/g, '').replace(/^00/, '+');
}

// Tool to look up if a candidate already exists in the system
export const lookupCandidateTool = createTool({
  id: 'lookup-candidate',
  description: 'Check if a candidate already exists in our system by phone number, email, or name. Use this early in the conversation when a candidate provides their contact information to determine if they are new or returning.',
  inputSchema: z.object({
    phone: z.string().optional().describe('Phone number to search for'),
    email: z.string().email().optional().describe('Email address to search for'),
    fullName: z.string().optional().describe('Full name to search for (less reliable, use phone/email when possible)'),
  }).refine(
    (data) => data.phone || data.email || data.fullName,
    { message: 'At least one search parameter (phone, email, or name) must be provided' }
  ),
  outputSchema: z.object({
    found: z.boolean(),
    candidate: z.object({
      applicationId: z.string(),
      fullName: z.string(),
      phone: z.string(),
      email: z.string().optional(),
      status: z.string(),
      appliedAt: z.string(),
      lastContactAt: z.string(),
      notes: z.string().optional(),
    }).optional(),
    message: z.string(),
  }),
  execute: async ({ phone, email, fullName }) => {
    // In production: Query your database or CRM here
    // Example: const candidate = await db.candidates.findFirst({ where: { OR: [{ phone }, { email }] } });
    
    let foundCandidate: StoredCandidate | undefined;
    
    // Search by phone (most reliable)
    if (phone) {
      const normalizedSearch = normalizePhone(phone);
      for (const [, candidate] of candidateStore) {
        if (normalizePhone(candidate.phone) === normalizedSearch) {
          foundCandidate = candidate;
          break;
        }
      }
    }
    
    // Search by email if not found by phone
    if (!foundCandidate && email) {
      const emailLower = email.toLowerCase();
      for (const [, candidate] of candidateStore) {
        if (candidate.email?.toLowerCase() === emailLower) {
          foundCandidate = candidate;
          break;
        }
      }
    }
    
    // Search by name as last resort (less reliable due to variations)
    if (!foundCandidate && fullName) {
      const nameLower = fullName.toLowerCase().trim();
      for (const [, candidate] of candidateStore) {
        if (candidate.fullName.toLowerCase().trim() === nameLower) {
          foundCandidate = candidate;
          break;
        }
      }
    }
    
    if (foundCandidate) {
      // Update last contact time
      foundCandidate.lastContactAt = new Date().toISOString();
      
      console.log(`🔍 Returning candidate found: ${foundCandidate.fullName} (${foundCandidate.applicationId})`);
      
      return {
        found: true,
        candidate: foundCandidate,
        message: `Welcome back! Found existing application ${foundCandidate.applicationId} for ${foundCandidate.fullName}, status: ${foundCandidate.status}`,
      };
    }
    
    console.log(`🔍 No existing candidate found for: ${phone || email || fullName}`);
    
    return {
      found: false,
      candidate: undefined,
      message: 'No existing application found. This appears to be a new candidate.',
    };
  },
});

// Helper function to save candidate to store (called after successful application)
function saveCandidateToStore(data: {
  applicationId: string;
  fullName: string;
  phone: string;
  email?: string;
}): void {
  candidateStore.set(data.applicationId, {
    ...data,
    status: 'pending',
    appliedAt: new Date().toISOString(),
    lastContactAt: new Date().toISOString(),
  });
}

// Tool to submit candidate application for nanny/governess positions
export const submitCandidateApplicationTool = createTool({
  id: 'submit-candidate-application',
  description: 'Submit a candidate application when you have collected all required information from a potential nanny/governess. Use this tool once you have gathered their basic details, experience, and qualifications.',
  inputSchema: z.object({
    // Personal Information
    fullName: z.string().describe('Full legal name of the candidate'),
    email: z.string().email().optional().describe('Email address (optional if phone/WhatsApp provided)'),
    phone: z.string().describe('Phone number with country code - PRIMARY CONTACT METHOD'),
    preferredContactMethod: z.enum(['phone', 'whatsapp', 'email', 'telegram']).describe('How the candidate prefers to be contacted'),
    nationality: z.string().describe('Country of citizenship'),
    currentLocation: z.string().describe('Current city and country of residence'),
    dateOfBirth: z.string().optional().describe('Date of birth (optional)'),
    
    // Languages
    languages: z.array(z.object({
      language: z.string(),
      fluency: z.enum(['native', 'fluent', 'intermediate', 'basic']),
    })).describe('Languages spoken with fluency level'),
    
    // Experience
    yearsOfExperience: z.number().min(0).describe('Total years of childcare experience'),
    ageGroupsWorkedWith: z.array(z.enum([
      'newborn (0-1)',
      'toddler (1-3)',
      'preschool (3-5)',
      'school-age (5-12)',
      'teenager (12+)',
    ])).describe('Age groups the candidate has experience with'),
    previousPositions: z.string().describe('Brief summary of previous nanny/governess positions'),
    
    // Qualifications
    hasFirstAidCertificate: z.boolean().describe('Whether candidate has valid First Aid certification'),
    educationSummary: z.string().describe('Highest education level and relevant certifications'),
    specializations: z.array(z.string()).optional().describe('Special skills like newborn care, special needs, tutoring subjects, music, sports'),
    
    // Availability & Preferences
    availableFrom: z.string().describe('When candidate can start working'),
    preferredArrangement: z.enum(['live-in', 'live-out', 'flexible']).describe('Preferred living arrangement'),
    willingToRelocate: z.boolean().describe('Whether candidate is willing to relocate internationally'),
    preferredCountries: z.array(z.string()).optional().describe('Countries where candidate would like to work'),
    
    // Documents & Media (file references from messaging platform or URLs)
    resumeFile: z.object({
      fileId: z.string().describe('File ID from messaging platform (WhatsApp, Telegram) or storage service'),
      fileName: z.string().optional().describe('Original file name'),
      fileType: z.string().optional().describe('MIME type (e.g., application/pdf, application/msword)'),
      fileUrl: z.string().url().optional().describe('Direct URL to the file if available'),
    }).optional().describe('Resume/CV file sent by candidate'),
    introVideoFile: z.object({
      fileId: z.string().describe('File ID from messaging platform or storage service'),
      fileName: z.string().optional().describe('Original file name'),
      fileType: z.string().optional().describe('MIME type (e.g., video/mp4)'),
      fileUrl: z.string().url().optional().describe('Direct URL to the video if available'),
      duration: z.number().optional().describe('Video duration in seconds if known'),
    }).optional().describe('2-3 minute self-introduction video file sent by candidate'),
    
    // Additional
    hasValidPassport: z.boolean().describe('Whether candidate has a valid passport'),
    additionalNotes: z.string().optional().describe('Any additional information from the conversation'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    applicationId: z.string(),
    message: z.string(),
    nextSteps: z.array(z.string()),
  }),
  execute: async (data) => {
    // Generate a unique application ID
    const applicationId = `AZM-${Date.now().toString(36).toUpperCase()}`;
    
    // Normalize phone number for file lookup
    const normalizedPhone = normalizePhone(data.phone);
    
    // Automatically inject files from file store if available
    let finalResumeFile = data.resumeFile;
    let finalIntroVideoFile = data.introVideoFile;
    
    const storedFiles = fileStoreByPhone.get(normalizedPhone);
    if (storedFiles) {
      // Use stored files if not provided in tool call
      if (!finalResumeFile && storedFiles.resumeFile) {
        finalResumeFile = storedFiles.resumeFile;
        console.log('📎 Auto-injected resume from file store (fileId=%s, fileUrl=%s)', storedFiles.resumeFile.fileId, storedFiles.resumeFile.fileUrl ? 'yes' : 'no');
      }
      if (!finalIntroVideoFile && storedFiles.introVideoFile) {
        finalIntroVideoFile = storedFiles.introVideoFile;
        console.log('📎 Auto-injected video from file store (fileId=%s, fileUrl=%s)', storedFiles.introVideoFile.fileId, storedFiles.introVideoFile.fileUrl ? 'yes' : 'no');
      }

      // Clean up after use
      fileStoreByPhone.delete(normalizedPhone);
    } else {
      console.warn('📎 No files in fileStoreByPhone for phone %s – files may not reach amoCRM', normalizedPhone);
    }
    
    // Save to local store
    saveCandidateToStore({
      applicationId,
      fullName: data.fullName,
      phone: data.phone,
      email: data.email,
    });
    
    console.log('📝 New Candidate Application Received:');
    console.log(JSON.stringify({ ...data, resumeFile: finalResumeFile, introVideoFile: finalIntroVideoFile }, null, 2));

    // Resolve fileUrl from Telegram when we have fileId but no fileUrl (e.g. getFileUrl failed at store time)
    async function ensureFileUrl<T extends { fileId: string; fileUrl?: string }>(file: T | undefined, label: string): Promise<T | undefined> {
      if (!file) return undefined;
      if (file.fileUrl) return file;
      try {
        const url = await getFileUrl(file.fileId);
        console.log('📎 Resolved %s fileUrl from fileId %s', label, file.fileId);
        return { ...file, fileUrl: url };
      } catch (e) {
        console.warn('📎 Could not resolve %s fileUrl for fileId %s:', label, file.fileId, e);
        return file;
      }
    }
    const resumeForAmo = await ensureFileUrl(finalResumeFile, 'resume');
    const videoForAmo = await ensureFileUrl(finalIntroVideoFile, 'video');

    // Upload to amoCRM with files
    let amoResult;
    try {
      amoResult = await createCandidateLead({
        ...data,
        applicationId,
        resumeFile: resumeForAmo,
        introVideoFile: videoForAmo,
      });
      console.log('✅ Candidate uploaded to amoCRM:', amoResult.leadUrl);
    } catch (error) {
      console.error('❌ Failed to upload to amoCRM:', error);
      // Continue anyway - don't fail the application if CRM is down
    }
    
    const nextSteps = [
      'Our recruitment team will review your application within 2-3 business days',
      data.email 
        ? 'You will receive an email with next steps and required documents'
        : `We will contact you via ${data.preferredContactMethod} with next steps and required documents`,
    ];
    
    // Add reminders for missing documents
    if (!data.resumeFile) {
      nextSteps.push('Please send us your resume/CV when ready');
    }
    if (!data.introVideoFile) {
      nextSteps.push('Please record and send a 2-3 minute introduction video about yourself');
    }
    
    nextSteps.push(
      'Prepare your DBS/criminal background check documents',
      'Gather references from previous employers',
      'Have your educational certificates ready for verification',
    );
    
    return {
      success: true,
      applicationId,
      message: `Thank you, ${data.fullName}! Your application has been submitted successfully.`,
      nextSteps,
    };
  },
});

// Tool to check application requirements
export const checkRequirementsTool = createTool({
  id: 'check-requirements',
  description: 'Explain the requirements and documents needed for a specific type of position or country',
  inputSchema: z.object({
    positionType: z.enum(['nanny', 'governess', 'tutor', 'maternity-nurse']).describe('Type of position'),
    targetCountry: z.string().optional().describe('Country where candidate wants to work'),
  }),
  outputSchema: z.object({
    requirements: z.array(z.object({
      category: z.string(),
      items: z.array(z.string()),
      mandatory: z.boolean(),
    })),
  }),
  execute: async ({ positionType, targetCountry }) => {
    const baseRequirements = [
      {
        category: 'Background Check',
        items: [
          'Criminal background check (DBS check for UK)',
          'No history of child abuse or neglect',
          'Clean record regarding violence or drug offenses',
        ],
        mandatory: true,
      },
      {
        category: 'Documentation',
        items: [
          'Valid passport',
          'Work visa/permit for target country',
          'References from at least 2 previous employers',
        ],
        mandatory: true,
      },
      {
        category: 'Medical',
        items: [
          'HIV test (negative)',
          'Hepatitis B & C tests',
          'Syphilis test',
          'Fluorography/chest X-ray',
          'General health certificate',
        ],
        mandatory: true,
      },
      {
        category: 'Qualifications',
        items: [
          'Relevant childcare education or certification',
          'First Aid Certificate',
          'CPR certification (recommended)',
        ],
        mandatory: positionType === 'governess' || positionType === 'maternity-nurse',
      },
    ];

    if (positionType === 'governess') {
      baseRequirements.push({
        category: 'Education (Governess)',
        items: [
          'University degree (preferably in education)',
          'Teaching certification or experience',
          'Fluency in at least 2 languages',
        ],
        mandatory: true,
      });
    }


    return { requirements: baseRequirements };
  },
});

// Tool to schedule a callback with a recruiter
export const scheduleCallbackTool = createTool({
  id: 'schedule-callback',
  description: 'Schedule a callback with a human recruiter for candidates who want to speak with someone directly, or when they cannot provide required information and need human assistance',
  inputSchema: z.object({
    candidateName: z.string().describe('Name of the candidate'),
    phone: z.string().describe('Phone number to call'),
    email: z.string().email().optional().describe('Email for confirmation (optional)'),
    preferredTime: z.string().describe('Preferred time for callback (e.g., "tomorrow morning", "Wednesday 2pm Moscow time")'),
    timezone: z.string().describe('Candidate timezone'),
    topicOfDiscussion: z.string().optional().describe('What the candidate wants to discuss'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    confirmationDetails: z.string(),
  }),
  execute: async (data) => {
    // In production: integrate with calendar API (Google Calendar, Calendly, etc.)
    console.log('📞 Callback Request:', JSON.stringify(data, null, 2));
    
    const confirmationMethod = data.email 
      ? `A confirmation email has been sent to ${data.email}.`
      : 'You will receive a confirmation via phone/SMS.';
    
    return {
      success: true,
      message: `Callback scheduled for ${data.candidateName}`,
      confirmationDetails: `Our recruiter will call you at ${data.phone} during ${data.preferredTime} (${data.timezone}). ${confirmationMethod}`,
    };
  },
});
