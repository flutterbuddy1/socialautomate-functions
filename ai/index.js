import { Client, Databases, Storage, ID, Query, InputFile } from 'node-appwrite';
import OpenAI from 'openai';

/**
 * AI Functions: 
 * - generateAIText (via OpenAI)
 * - generateAIImage (via DALL-E)
 */

export default async ({ req, res, log, error }) => {
    const client = new Client()
        .setEndpoint(process.env.APPWRITE_ENDPOINT)
        .setProject(process.env.APPWRITE_PROJECT_ID)
        .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);
    const storage = new Storage(client);

    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
    });

    const DATABASE_ID = process.env.DATABASE_ID || '699c08a50014cc1ba505';
    const BRAND_COLLECTION = 'brand_profiles';
    const SUB_COLLECTION = 'subscriptions';
    const BUCKET_ID = 'generated_images';

    const userId = req.headers['x-appwrite-user-id'];
    if (!userId) return res.json({ success: false, error: 'Unauthorized' }, 401);

    const { action, prompt, tone, platform } = JSON.parse(req.body);

    try {
        // Fetch Brand Profile for context
        const brandResults = await databases.listDocuments(DATABASE_ID, BRAND_COLLECTION, [
            Query.equal('userId', userId)
        ]);
        const brand = brandResults.total > 0 ? brandResults.documents[0] : null;

        if (action === 'generateText') {
            const response = await openai.chat.completions.create({
                model: "gpt-4-turbo-preview",
                messages: [
                    {
                        role: "system",
                        content: `You are a social media expert. Generate a high-engaging ${platform || 'general'} post for a brand. 
            Industry: ${brand?.industry || 'Unknown'}. 
            Tone: ${tone || brand?.tone || 'Professional'}. 
            Target Audience: ${brand?.targetAudience || 'General'}.`
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
            });

            const content = response.choices[0].message.content;
            return res.json({ success: true, data: { content } });
        }

        if (action === 'generateImage') {
            // 1. Check Credits
            const subResults = await databases.listDocuments(DATABASE_ID, SUB_COLLECTION, [
                Query.equal('userId', userId),
                Query.equal('status', 'active')
            ]);

            if (subResults.total === 0 || subResults.documents[0].imageCreditsRemaining <= 0) {
                return res.json({ success: false, error: 'Insufficient image credits' }, 403);
            }

            const subscription = subResults.documents[0];

            // 2. Generate Image
            const imageResponse = await openai.images.generate({
                model: "dall-e-3",
                prompt: prompt,
                n: 1,
                size: "1024x1024",
            });

            const imageUrl = imageResponse.data[0].url;

            // 3. Download and Upload to Appwrite Storage
            const imgBuffer = await fetch(imageUrl).then(r => r.arrayBuffer());
            const file = await storage.createFile(
                BUCKET_ID,
                ID.unique(),
                InputFile.fromBuffer(Buffer.from(imgBuffer), 'generated_image.png')
            );

            // 4. Deduct Credit
            await databases.updateDocument(DATABASE_ID, SUB_COLLECTION, subscription.$id, {
                imageCreditsRemaining: subscription.imageCreditsRemaining - 1
            });

            return res.json({ success: true, data: { fileId: file.$id, url: imageUrl } });
        }

        return res.json({ success: false, error: 'Invalid action' }, 400);

    } catch (err) {
        error('AI Function Error: ' + err.message);
        return res.json({ success: false, error: err.message }, 500);
    }
};
