import { Client } from 'node-appwrite';
import { GoogleGenerativeAI } from '@google/generative-ai';

export default async ({ req, res, log, error }) => {
    log('Gemini Caption Generator started');

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

        const { businessName, industry, tone, targetAudience, platform } = body;

        if (!businessName || !industry || !tone || !targetAudience || !platform) {
            error('Missing required fields in request body');
            return res.json({ success: false, error: 'businessName, industry, tone, targetAudience, and platform are required' }, 400);
        }

        // 3. Initialize Gemini
        const genAI = new GoogleGenerativeAI(geminiApiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });

        // 4. Construct Prompt
        const prompt = `
            You are a professional social media copywriter.
            Create an engaging and viral-ready social media caption based on the following details:

            Business Name: ${businessName}
            Industry: ${industry}
            Tone: ${tone}
            Target Audience: ${targetAudience}
            Platform: ${platform}

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

        // 5. Parse Response
        // We expect a format like "Caption: ... Hashtags: ..."
        const captionMatch = text.match(/Caption:([\s\S]*?)Hashtags:/i);
        const hashtagsMatch = text.match(/Hashtags:([\s\S]*)/i);

        const caption = captionMatch ? captionMatch[1].trim() : '';
        const hashtagsRaw = hashtagsMatch ? hashtagsMatch[1].trim() : '';
        const hashtags = hashtagsRaw.split(/\s+/).filter(tag => tag.startsWith('#'));

        if (!caption) {
            error('Failed to parse caption from Gemini response: ' + text);
            throw new Error('Could not parse valid caption from AI response');
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
