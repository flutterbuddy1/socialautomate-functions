import { Client } from 'node-appwrite';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fetch, { Headers, Request, Response } from 'node-fetch';

// Robust polyfill for environments without built-in fetch (Node < 18)
if (!globalThis.fetch) {
    globalThis.fetch = fetch;
    globalThis.Headers = Headers;
    globalThis.Request = Request;
    globalThis.Response = Response;
}

export default async ({ req, res, log, error }) => {
    log('Gemini Caption Generator started');
    log('Node Version: ' + process.version);
    log('Native fetch present: ' + (typeof globalThis.fetch !== 'undefined'));

    try {
        // 1. Validate Environment Variables
        const geminiApiKey = process.env.GEMINI_API_KEY;
        if (!geminiApiKey) {
            error('Missing GEMINI_API_KEY');
            return res.json({ success: false, error: 'Internal configuration error: GEMINI_API_KEY is missing.' }, 500);
        }

        // 2. Extract and Validate Input
        let body;
        try {
            body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
            log('Request payload: ' + JSON.stringify(body));
        } catch (e) {
            error('JSON Parse Error: ' + e.message);
            return res.json({ success: false, error: 'Invalid JSON request body' }, 400);
        }

        const { businessName, bussinessName, industry, tone, targetAudience, platform, topic } = body;

        // Use either spelling of business name to be safe
        const actualBusinessName = businessName || bussinessName;

        const missing = [];
        if (!actualBusinessName) missing.push('businessName');
        if (!industry) missing.push('industry');
        if (!tone) missing.push('tone');
        if (!targetAudience) missing.push('targetAudience');
        if (!platform) missing.push('platform');

        if (missing.length > 0) {
            error('Missing fields: ' + missing.join(', '));
            return res.json({ success: false, error: `Missing required brand data: ${missing.join(', ')}. Please check your Brand Profile in Onboarding.` }, 400);
        }

        // 3. Initialize Gemini
        const genAI = new GoogleGenerativeAI(geminiApiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

        // 4. Construct Prompt
        const prompt = `
            You are a professional social media copywriter.
            Create an engaging and viral-ready social media caption based on the following details:

            Business Name: ${businessName}
            Industry: ${industry}
            Tone: ${tone}
            Target Audience: ${targetAudience}
            Platform: ${platform}
            Topic/Context: ${topic || 'General brand update and engagement'}

            Instructions:
            - Write a catchy hook in the first line
            - Write 3-5 engaging lines about the business
            - Add a strong call-to-action encouraging engagement
            - Include 8-12 trending and relevant hashtags for the platform
            - Make the caption optimized for ${platform} engagement and visibility

            Return the response in the following format ONLY:
            Caption:
            [The post content]

            Hashtags:
            [8-12 hashtags separated by spaces]
        `;

        log('Step 1: Sending request to Gemini API...');
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        log('Gemini response received.');

        // 5. Parse Response - More Robustly
        log('Raw AI Text: ' + text);

        let caption = '';
        let hashtags = [];

        // Regular regex for "Caption: ... Hashtags: ..."
        const captionMatch = text.match(/Caption:?([\s\S]*?)(?:Hashtags:?|$)/i);
        const hashtagsMatch = text.match(/Hashtags:?([\s\S]*)/i);

        if (captionMatch && captionMatch[1].trim()) {
            caption = captionMatch[1].trim();
        }

        if (hashtagsMatch && hashtagsMatch[1].trim()) {
            const rawHashtags = hashtagsMatch[1].trim();
            hashtags = rawHashtags.split(/\s+/).filter(tag => tag.startsWith('#'));
        }

        // Fallback: If no Caption header but the text is solid, use the whole text but strip hashtags
        if (!caption && text.length > 50) {
            log('Note: Caption header missing, attempting fallback extraction');
            // Remove hashtags from the main text for the caption part
            caption = text.replace(/#\w+/g, '').trim();
            // If hashtags list is still empty, grab them from the text
            if (hashtags.length === 0) {
                hashtags = text.match(/#\w+/g) || [];
            }
        }

        if (!caption) {
            error('Failed to extract caption from Gemini response. Raw text: ' + text);
            return res.json({ success: false, error: 'AI generated a response but it was in an invalid format. Please try again.' }, 500);
        }

        return res.json({
            success: true,
            data: {
                caption,
                hashtags
            }
        });

    } catch (err) {
        error('Runtime Exception: ' + err.message);
        return res.json({
            success: false,
            error: 'AI generation failed: ' + err.message
        }, 500);
    }
};
