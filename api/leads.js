const axios = require('axios');

// In-Memory Database fallback (shared across warm serverless containers)
// For a production database, define process.env.MONGODB_URI or process.env.DATABASE_URL
let leadsDb = [];

module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { method } = req;

  if (method === 'GET') {
    // Return all leads stored in the database
    return res.status(200).json({
      success: true,
      count: leadsDb.length,
      data: leadsDb
    });
  }

  if (method === 'DELETE') {
    // Clear database for testing convenience
    leadsDb = [];
    return res.status(200).json({
      success: true,
      message: "Database cleared successfully."
    });
  }

  if (method === 'POST') {
    try {
      const { name, phone, clinic_preference } = req.body;

      // 1. Validation
      if (!name || !phone) {
        return res.status(400).json({
          success: false,
          error: "Missing required fields: name and phone are mandatory."
        });
      }

      const formattedPhone = phone.startsWith('+91') ? phone : `+91${phone}`;

      // Initialize status flags for integrations
      let hubspotStatus = 'Skipped (No API Key)';
      let whatsappStatus = 'Skipped (No API Key)';
      let integrationLogs = [];

      // 2. HubSpot Integration (with Phone Deduplication Logic)
      const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
      if (HUBSPOT_ACCESS_TOKEN) {
        try {
          integrationLogs.push("Querying HubSpot Search API for duplicate phone number...");
          
          // Search contact by phone
          const searchResponse = await axios.post(
            'https://api.hubapi.com/crm/v3/objects/contacts/search',
            {
              filterGroups: [
                {
                  filters: [
                    {
                      propertyName: 'phone',
                      operator: 'EQ',
                      value: formattedPhone
                    }
                  ]
                }
              ],
              properties: ['firstname', 'lastname', 'phone', 'hs_lead_status']
            },
            {
              headers: {
                Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
              }
            }
          );

          const searchResults = searchResponse.data.results || [];

          if (searchResults.length > 0) {
            // Contact exists -> Update contact (Deduplication Step)
            const existingContact = searchResults[0];
            integrationLogs.push(`Found existing HubSpot contact ID: ${existingContact.id}. Performing update...`);
            
            await axios.patch(
              `https://api.hubapi.com/crm/v3/objects/contacts/${existingContact.id}`,
              {
                properties: {
                  hs_lead_status: 'NEW_ENQUIRY',
                  clinic_preference: clinic_preference || 'Bengaluru Clinic',
                  campaign_source: 'Google Ads - Consultation Landing Page'
                }
              },
              {
                headers: {
                  Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
                  'Content-Type': 'application/json'
                }
              }
            );
            hubspotStatus = `Updated Contact (ID: ${existingContact.id})`;
            integrationLogs.push("HubSpot contact updated successfully.");
          } else {
            // New Contact -> Create contact
            integrationLogs.push("No matching contact found. Creating new contact record in HubSpot...");
            const names = name.split(' ');
            const firstName = names[0];
            const lastName = names.slice(1).join(' ') || 'Patient';

            const createResponse = await axios.post(
              'https://api.hubapi.com/crm/v3/objects/contacts',
              {
                properties: {
                  firstname: firstName,
                  lastname: lastName,
                  phone: formattedPhone,
                  hs_lead_status: 'NEW_ENQUIRY',
                  clinic_preference: clinic_preference || 'Bengaluru Clinic',
                  campaign_source: 'Google Ads - Consultation Landing Page'
                }
              },
              {
                headers: {
                  Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
                  'Content-Type': 'application/json'
                }
              }
            );
            hubspotStatus = `Created New Contact (ID: ${createResponse.data.id})`;
            integrationLogs.push(`HubSpot contact created successfully with ID: ${createResponse.data.id}.`);
          }
        } catch (hsError) {
          hubspotStatus = `Failed: ${hsError.response?.data?.message || hsError.message}`;
          integrationLogs.push(`HubSpot Integration Error: ${hsError.message}`);
        }
      } else {
        integrationLogs.push("HubSpot integration skipped: HUBSPOT_ACCESS_TOKEN not set in environment.");
      }

      // 3. WhatsApp Integration via Karix API
      const KARIX_API_KEY = process.env.KARIX_API_KEY;
      if (KARIX_API_KEY) {
        try {
          integrationLogs.push("Sending WhatsApp confirmation template via Karix API...");
          const karirResponse = await axios.post(
            'https://api.karix.io/whatsapp/v1/send',
            {
              to: formattedPhone,
              type: 'template',
              template: {
                namespace: 'orthonow_campaign',
                name: 'consultation_confirmation',
                language: { code: 'en' },
                components: [
                  {
                    type: 'body',
                    parameters: [
                      { type: 'text', text: name } // Parameter 1: Patient Name
                    ]
                  }
                ]
              }
            },
            {
              headers: {
                'Authorization': `Bearer ${KARIX_API_KEY}`,
                'Content-Type': 'application/json'
              }
            }
          );
          whatsappStatus = 'Sent Successfully';
          integrationLogs.push("WhatsApp confirmation triggered successfully.");
        } catch (waError) {
          whatsappStatus = `Failed: ${waError.message}`;
          integrationLogs.push(`Karix WhatsApp API Error: ${waError.message}`);
        }
      } else {
        integrationLogs.push("WhatsApp dispatch skipped: KARIX_API_KEY not set in environment.");
      }

      // 4. Save to Database (In-Memory Array with complete payload)
      const leadRecord = {
        id: `lead_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        name,
        phone: formattedPhone,
        clinic_preference: clinic_preference || 'Bengaluru Clinic',
        created_at: new Date().toISOString(),
        hubspot_status: hubspotStatus,
        whatsapp_status: whatsappStatus,
        integration_logs: integrationLogs
      };

      leadsDb.push(leadRecord);

      // Print server logs
      console.log("== New Lead Saved to Database ==");
      console.log(JSON.stringify(leadRecord, null, 2));

      return res.status(200).json({
        success: true,
        message: "Lead processed and saved to database successfully.",
        data: leadRecord
      });
    } catch (error) {
      console.error("Backend Error:", error);
      return res.status(500).json({
        success: false,
        error: "Internal Server Error: " + error.message
      });
    }
  }

  res.status(405).json({ success: false, error: `Method ${method} Not Allowed` });
};
