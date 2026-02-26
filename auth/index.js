import { Client, Databases, ID, Query } from 'node-appwrite';

/**
 * Function 2: Connect Social Account
 * - Store OAuth tokens securely
 * - Save platform, accessToken, refreshToken, expiresAt
 */

export default async ({ req, res, log, error }) => {
    const client = new Client()
        .setEndpoint(process.env.APPWRITE_ENDPOINT)
        .setProject(process.env.APPWRITE_PROJECT_ID)
        .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);

    const DATABASE_ID = process.env.DATABASE_ID || '699c08a50014cc1ba505';
    const COLLECTION_ID = 'connected_accounts';

    const userId = req.headers['x-appwrite-user-id'];
    if (!userId) {
        return res.json({ success: false, error: 'Unauthorized' }, 401);
    }

    try {
        const { platform, accessToken, refreshToken, expiresAt, platformUserId, platformUserName } = JSON.parse(req.body);

        if (!platform || !accessToken) {
            return res.json({ success: false, error: 'Platform and Access Token are required' }, 400);
        }

        // Check if account already connected for this user and platform
        const existing = await databases.listDocuments(DATABASE_ID, COLLECTION_ID, [
            Query.equal('userId', userId),
            Query.equal('platform', platform)
        ]);

        const accountData = {
            userId,
            platform,
            accessToken, // In production, consider encrypting this before saving
            refreshToken,
            expiresAt,
            platformUserId,
            platformUserName,
            updatedAt: new Date().toISOString()
        };

        let result;
        if (existing.total > 0) {
            result = await databases.updateDocument(
                DATABASE_ID,
                COLLECTION_ID,
                existing.documents[0].$id,
                accountData
            );
            log(`Updated ${platform} account for user: ${userId}`);
        } else {
            result = await databases.createDocument(
                DATABASE_ID,
                COLLECTION_ID,
                ID.unique(),
                { ...accountData, createdAt: new Date().toISOString() }
            );
            log(`Connected new ${platform} account for user: ${userId}`);
        }

        return res.json({ success: true, data: result });
    } catch (err) {
        error('Error connecting social account: ' + err.message);
        return res.json({ success: false, error: err.message }, 500);
    }
};
