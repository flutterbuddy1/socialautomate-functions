import { Client, Databases, Storage, ID, Query } from 'node-appwrite';

/**
 * Function 1: Create Brand Profile
 * - Save brand info to database
 * - Handle logo file (stored in storage bucket)
 * - Validate user session
 */

export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT)
    .setProject(process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);
  const storage = new Storage(client);

  const DATABASE_ID = process.env.DATABASE_ID || '699c08a50014cc1ba505';
  const COLLECTION_ID = 'brand_profiles';
  const BUCKET_ID = '699ea200000d168a2f64';

  // Security Check: Ensure userId is present in headers (provided by Appwrite)
  const userId = req.headers['x-appwrite-user-id'];
  if (!userId) {
    return res.json({ success: false, error: 'Unauthorized: User session required' }, 401);
  }

  try {
    const { businessName, industry, targetAudience, tone, primaryColor, secondaryColor, logoFieldId, goal } = JSON.parse(req.body);

    if (!businessName) {
      return res.json({ success: false, error: 'Brand name is required' }, 400);
    }

    // Check if profile already exists for this user
    const existing = await databases.listDocuments(DATABASE_ID, COLLECTION_ID, [
      Query.equal('userId', userId)
    ]);

    let profile;
    const profileData = {
      userId,
      businessName,
      industry,
      targetAudience,
      tone,
      primaryColor: primaryColor || '#4f46e5',
      secondaryColor: secondaryColor || '#818cf8',
      logoFieldId: logoFieldId || '',
      goal: goal || '',
      updatedAt: new Date().toISOString()
    };

    if (existing.total > 0) {
      // Update existing
      profile = await databases.updateDocument(
        DATABASE_ID,
        COLLECTION_ID,
        existing.documents[0].$id,
        profileData
      );
      log(`Updated brand profile for user: ${userId}`);
    } else {
      // Create new
      profile = await databases.createDocument(
        DATABASE_ID,
        COLLECTION_ID,
        ID.unique(),
        { ...profileData, createdAt: new Date().toISOString() }
      );
      log(`Created brand profile for user: ${userId}`);
    }

    return res.json({ success: true, data: profile });
  } catch (err) {
    error('Error creating brand profile: ' + err.message);
    return res.json({ success: false, error: err.message }, 500);
  }
};
