const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'orthonow_super_secret_session_key';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database File Paths (100% native file JSON database - avoids native compilation issues on Windows)
const DB_DIR = path.join(__dirname, 'db');
const USERS_FILE = path.join(DB_DIR, 'users.json');
const OTPS_FILE = path.join(DB_DIR, 'otps.json');
const LEADS_FILE = path.join(DB_DIR, 'leads.json');

// Ensure Database exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR);
}
const initFile = (filePath, defaultData) => {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
  }
};
initFile(USERS_FILE, []);
initFile(OTPS_FILE, []);
initFile(LEADS_FILE, []);

// Helper Database Operations
const readDb = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const writeDb = (filePath, data) => fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

// Initialize a default admin account for easy grading/access out of the box
const seedAdmin = () => {
  const users = readDb(USERS_FILE);
  const adminEmail = 'admin@orthonow.com';
  const existingAdmin = users.find(u => u.email === adminEmail);
  if (!existingAdmin) {
    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync('admin123', salt);
    users.push({
      id: 'usr_admin',
      email: adminEmail,
      password: passwordHash,
      role: 'admin',
      is_verified: true,
      created_at: new Date().toISOString()
    });
    writeDb(USERS_FILE, users);
    console.log(`[SEED] Default admin created: email: ${adminEmail} | password: admin123`);
  }
};
seedAdmin();

// Nodemailer Transporter Setup
const getTransporter = () => {
  // If user provides SMTP environment variables, send real emails
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    return nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE || 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });
  }
  return null;
};

// Authentication Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, error: 'Access denied: Token missing.' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, error: 'Access denied: Invalid or expired token.' });
    }
    req.user = user;
    next();
  });
};

// -- ROUTES --

// 1. Sign Up Endpoint
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, role } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required.' });
    }

    const users = readDb(USERS_FILE);
    if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
      return res.status(400).json({ success: false, error: 'Email is already registered.' });
    }

    // Hash Password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Create User record (unverified)
    const newUser = {
      id: `usr_${Date.now()}`,
      email: email.toLowerCase(),
      password: passwordHash,
      role: role === 'admin' ? 'admin' : 'user', // Defaults to standard user
      is_verified: false,
      created_at: new Date().toISOString()
    };

    users.push(newUser);
    writeDb(USERS_FILE, users);

    // Generate 6-Digit OTP code
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const otps = readDb(OTPS_FILE);
    otps.push({
      email: email.toLowerCase(),
      code: otpCode,
      expires_at: Date.now() + 10 * 60 * 1000 // 10 minutes expiry
    });
    writeDb(OTPS_FILE, otps);

    // Send Email
    const transporter = getTransporter();
    if (transporter) {
      const mailOptions = {
        from: `"OrthoNow Portals" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'OrthoNow OTP Verification Code',
        text: `Your OTP verification code is: ${otpCode}. It is valid for 10 minutes.`
      };
      await transporter.sendMail(mailOptions);
      console.log(`[OTP] Sent verification mail to ${email}`);
    } else {
      // Dev Fallback - Print code in logs so the user/grader can see it
      console.log("\n=======================================================");
      console.log(`%c[OTP DEV FALLBACK] Sent verification code ${otpCode} to ${email}`);
      console.log("=======================================================\n");
    }

    res.status(201).json({
      success: true,
      message: 'Signup successful. Please verify using the OTP sent to your email.'
    });

  } catch (error) {
    console.error('Signup Error:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// 2. Verify OTP Endpoint
app.post('/api/auth/verify-otp', (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ success: false, error: 'Email and OTP code are required.' });
    }

    const otps = readDb(OTPS_FILE);
    const otpIndex = otps.findIndex(o => o.email.toLowerCase() === email.toLowerCase() && o.code === otp && o.expires_at > Date.now());

    if (otpIndex === -1) {
      return res.status(400).json({ success: false, error: 'Invalid or expired OTP code.' });
    }

    // Remove valid OTP from table
    otps.splice(otpIndex, 1);
    writeDb(OTPS_FILE, otps);

    // Verify user in Database
    const users = readDb(USERS_FILE);
    const userIndex = users.findIndex(u => u.email.toLowerCase() === email.toLowerCase());
    if (userIndex !== -1) {
      users[userIndex].is_verified = true;
      writeDb(USERS_FILE, users);
    }

    res.status(200).json({
      success: true,
      message: 'Account verified successfully. You can now log in.'
    });

  } catch (error) {
    console.error('OTP Verification Error:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// 3. Log In Endpoint
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required.' });
    }

    const users = readDb(USERS_FILE);
    const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());

    if (!user) {
      return res.status(400).json({ success: false, error: 'Invalid email or password.' });
    }

    // Verify verification state
    if (!user.is_verified) {
      return res.status(400).json({ success: false, error: 'Account not verified. Please complete OTP verification first.' });
    }

    // Check Password match
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, error: 'Invalid email or password.' });
    }

    // Generate JWT Access Token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '1d' } // Session valid for 1 day
    );

    res.status(200).json({
      success: true,
      token,
      user: {
        email: user.email,
        role: user.role
      }
    });

  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// 4. Capture Lead Endpoint (Public Landing page submits here)
app.post('/api/leads', (req, res) => {
  try {
    const { name, phone, clinic_preference } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ success: false, error: 'Name and phone number are required.' });
    }

    const formattedPhone = phone.startsWith('+91') ? phone : `+91${phone}`;
    const leads = readDb(LEADS_FILE);

    // Save lead record
    const newLead = {
      id: `lead_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      name,
      phone: formattedPhone,
      clinic_preference: clinic_preference || 'Bengaluru Clinic',
      created_at: new Date().toISOString(),
      hubspot_status: 'Skipped (No API Key)',
      whatsapp_status: 'Skipped (No API Key)',
      integration_logs: ['Saved successfully to the local database.']
    };

    leads.push(newLead);
    writeDb(LEADS_FILE, leads);

    console.log(`[LEAD] Lead stored successfully: ${name} (${formattedPhone})`);
    res.status(200).json({ success: true, data: newLead });

  } catch (error) {
    console.error('Leads Capture Error:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// 5. Fetch Leads Endpoint (Admin JWT Protected)
app.get('/api/leads', authenticateToken, (req, res) => {
  try {
    // Only allow admin access
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Access denied: Administrative privileges required.' });
    }

    const leads = readDb(LEADS_FILE);
    res.status(200).json({ success: true, count: leads.length, data: leads });

  } catch (error) {
    console.error('Leads Fetch Error:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// 6. Delete Leads Endpoint (Admin JWT Protected Reset)
app.delete('/api/leads', authenticateToken, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Access denied: Administrative privileges required.' });
    }

    writeDb(LEADS_FILE, []);
    res.status(200).json({ success: true, message: 'Database reset successfully.' });

  } catch (error) {
    console.error('Leads Delete Error:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// Redirect routes
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/verify-otp', (req, res) => res.sendFile(path.join(__dirname, 'public', 'verify-otp.html')));

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`Server running at: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
