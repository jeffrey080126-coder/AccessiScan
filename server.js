const express = require("express");
const puppeteer = require("puppeteer");
const { JSDOM } = require("jsdom");
const axeSource = require("axe-core").source;
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const crypto = require("crypto");
const path = require("path");
require("dotenv").config();
const fetch = globalThis.fetch || require("node-fetch");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const scanCache = new Map();
const sessions = new Map();

// Database setup
const db = new sqlite3.Database('./accessiscan.db', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('✅ Connected to SQLite database');
    initializeDatabase();
  }
});

// Initialize database tables
function initializeDatabase() {
  db.serialize(() => {
    // Severe issues table
    db.run(`CREATE TABLE IF NOT EXISTS severe_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id TEXT,
      url TEXT,
      issue_id TEXT,
      title TEXT,
      severity TEXT,
      wcag_level TEXT,
      criterion TEXT,
      description TEXT,
      html_snippet TEXT,
      nodes_affected INTEGER,
      scan_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'active'
    )`);

    // Scan logs table
    db.run(`CREATE TABLE IF NOT EXISTS scan_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT,
      wcag_score INTEGER,
      compliance_level TEXT,
      total_issues INTEGER,
      severe_issues_count INTEGER,
      scan_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      scan_duration INTEGER,
      status TEXT DEFAULT 'completed'
    )`);

    // Dashboard stats table
    db.run(`CREATE TABLE IF NOT EXISTS dashboard_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      total_scans INTEGER DEFAULT 0,
      total_severe_issues INTEGER DEFAULT 0,
      avg_wcag_score REAL DEFAULT 0,
      last_scan_date DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Dashboard access logs table
    db.run(`CREATE TABLE IF NOT EXISTS dashboard_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT,
      method TEXT,
      ip_address TEXT,
      user_agent TEXT,
      query_params TEXT,
      response_status INTEGER,
      response_time INTEGER,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Users table for new sign-ups
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password_hash TEXT,
      salt TEXT,
      role TEXT DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    console.log('✅ Database tables initialized');
  });
}

// Middleware
app.use(cors());
app.use(express.json());

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie;
  if (!header) return cookies;
  header.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    const name = parts.shift().trim();
    const value = decodeURIComponent(parts.join('='));
    cookies[name] = value;
  });
  return cookies;
}

function createSession(username, role = 'user') {
  const sessionId = crypto.randomBytes(24).toString('hex');
  sessions.set(sessionId, { username, role, createdAt: Date.now() });
  return sessionId;
}

function getSession(req) {
  const cookies = parseCookies(req);
  return cookies.session_id ? sessions.get(cookies.session_id) : null;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

function verifyPassword(user, password) {
  if (!user || !user.password_hash || !user.salt) return false;
  const { hash } = hashPassword(password, user.salt);
  return hash === user.password_hash;
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) {
    if (req.path.endsWith('.html')) {
      return res.redirect('/login.html');
    }
    return res.status(401).json({ error: 'Unauthorized', redirect: '/login.html' });
  }
  req.user = session;
  next();
}

function requireDeveloperAuth(req, res, next) {
  const session = getSession(req);
  if (!session || session.role !== 'developer') {
    if (req.path.endsWith('.html')) {
      return res.redirect('/login.html');
    }
    return res.status(401).json({ error: 'Unauthorized', redirect: '/login.html' });
  }
  req.devUser = session.username;
  next();
}

app.post("/api/login", (req, res) => {
  const { username, password, remember } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const durationMs = remember ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    const devUsername = process.env.DEV_USERNAME || 'developer';
    const devPassword = process.env.DEV_PASSWORD || 'devpass';

    if (user && verifyPassword(user, password)) {
      const sessionId = createSession(user.username, user.role);
      res.cookie('session_id', sessionId, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: durationMs
      });
      return res.json({ success: true, role: user.role, redirect: user.role === 'developer' ? '/developer.html' : '/user.html' });
    }

    if (username === devUsername && password === devPassword) {
      const sessionId = createSession(username, 'developer');
      res.cookie('session_id', sessionId, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: durationMs
      });
      return res.json({ success: true, role: 'developer', redirect: '/developer.html' });
    }

    res.status(401).json({ error: 'Invalid username or password' });
  });
});

app.post('/api/register', (req, res) => {
  const { username, password, remember } = req.body;
  const devUsername = process.env.DEV_USERNAME || 'developer';
  const durationMs = remember ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (username === devUsername) {
    return res.status(400).json({ error: 'This username is reserved' });
  }

  db.get('SELECT * FROM users WHERE username = ?', [username], (err, existing) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    if (existing) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const { salt, hash } = hashPassword(password);
    db.run('INSERT INTO users (username, password_hash, salt, role) VALUES (?, ?, ?, ?)',
      [username, hash, salt, 'user'], function(insertErr) {
        if (insertErr) {
          return res.status(500).json({ error: 'Failed to create account' });
        }

        const sessionId = createSession(username, 'user');
        res.cookie('session_id', sessionId, {
          httpOnly: true,
          sameSite: 'lax',
          maxAge: durationMs
        });
        res.json({ success: true, redirect: '/user.html' });
      }
    );
  });
});

app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.session_id) {
    sessions.delete(cookies.session_id);
  }
  res.clearCookie('session_id');
  res.json({ success: true });
});

app.get('/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.session_id) {
    sessions.delete(cookies.session_id);
  }
  res.clearCookie('session_id');
  res.redirect('/login.html');
});

app.get('/api/user/profile', requireAuth, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

app.get('/api/dev/profile', requireDeveloperAuth, (req, res) => {
  res.json({ username: req.devUser, role: 'developer' });
});

app.get('/user.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'user.html'));
});

app.get('/developer.html', requireDeveloperAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'developer.html'));
});

app.use(express.static(".")); // Serve static  files

// WCAG 2.1 Mapping and Compliance Rules
const wcagRules = {
  "alt-text": { 
    level: "A", 
    criterion: "1.1.1", 
    severity: "critical", 
    title: "Missing Alternative Text for Images",
    description: "Images must have descriptive text (alt text) so screen readers can describe them to visually impaired users.",
    fix: "Add alt text to all images" 
  },
  "aria-allowed-attr": { 
    level: "A", 
    criterion: "4.1.2", 
    severity: "high", 
    title: "Invalid ARIA Attributes Used",
    description: "ARIA attributes must be used correctly according to specifications to ensure assistive technologies work properly.",
    fix: "Use only allowed ARIA attributes" 
  },
  "aria-hidden-body": { 
    level: "A", 
    criterion: "1.3.1", 
    severity: "critical", 
    title: "Body Element Hidden from Screen Readers",
    description: "The body element should not be hidden from assistive technologies as it contains the main content.",
    fix: "Avoid aria-hidden on body element" 
  },
  "aria-required-attr": { 
    level: "A", 
    criterion: "4.1.2", 
    severity: "high", 
    title: "Missing Required ARIA Attributes",
    description: "Some ARIA roles require specific attributes to function correctly with assistive technologies.",
    fix: "Add required ARIA attributes" 
  },
  "aria-role": { 
    level: "A", 
    criterion: "4.1.2", 
    severity: "high", 
    title: "Invalid ARIA Role Used",
    description: "ARIA roles must be valid and used appropriately to ensure proper screen reader navigation.",
    fix: "Use valid ARIA roles" 
  },
  "button-name": { 
    level: "A", 
    criterion: "4.1.2", 
    severity: "critical", 
    title: "Buttons Without Accessible Names",
    description: "All buttons must have text content or an accessible name so users know what the button does.",
    fix: "Provide accessible name for buttons" 
  },
  "color-contrast": { 
    level: "AA", 
    criterion: "1.4.3", 
    severity: "high", 
    title: "Insufficient Color Contrast",
    description: "Text must have enough contrast against its background for people with visual impairments to read it easily.",
    fix: "Ensure color contrast ratio >= 4.5:1" 
  },
  "duplicate-id": { 
    level: "A", 
    criterion: "4.1.1", 
    severity: "high", 
    title: "Duplicate ID Attributes",
    description: "HTML elements must have unique ID attributes to ensure proper functionality and accessibility.",
    fix: "Remove duplicate ID attributes" 
  },
  "empty-heading": { 
    level: "A", 
    criterion: "1.3.1", 
    severity: "medium", 
    title: "Empty Heading Elements",
    description: "Heading elements (h1-h6) must contain text content to provide proper document structure.",
    fix: "Add text content to headings" 
  },
  "form-field-multiple-labels": { 
    level: "A", 
    criterion: "4.1.3", 
    severity: "high", 
    title: "Form Fields with Multiple Labels",
    description: "Form input fields should have exactly one associated label for clarity and proper screen reader support.",
    fix: "Ensure form fields have one label" 
  },
  "image-alt": { 
    level: "A", 
    criterion: "1.1.1", 
    severity: "critical", 
    title: "Images Missing Alt Text",
    description: "All images must have alternative text that describes the image for users who cannot see it.",
    fix: "Add meaningful alt text to images" 
  },
  "label": { 
    level: "A", 
    criterion: "4.1.3", 
    severity: "critical", 
    title: "Form Inputs Without Labels",
    description: "All form input fields must be properly labeled so users understand what information is required.",
    fix: "Associate labels with form inputs" 
  },
  "link-name": { 
    level: "A", 
    criterion: "4.1.2", 
    severity: "critical", 
    title: "Links Without Descriptive Names",
    description: "Links must have descriptive text that clearly indicates where the link will take users.",
    fix: "Provide accessible name for links" 
  },
  "radio-group": { 
    level: "A", 
    criterion: "1.3.1", 
    severity: "high", 
    title: "Ungrouped Radio Buttons",
    description: "Related radio buttons must be grouped together using fieldset and legend elements.",
    fix: "Group radio buttons in fieldset" 
  },
  "select-name": { 
    level: "A", 
    criterion: "4.1.2", 
    severity: "critical", 
    title: "Select Elements Without Labels",
    description: "Dropdown select elements must have associated labels to identify their purpose.",
    fix: "Provide label for select elements" 
  },
  "target-size": { 
    level: "AAA", 
    criterion: "2.5.5", 
    severity: "medium", 
    title: "Clickable Elements Too Small",
    description: "Interactive elements like buttons and links should be large enough (at least 44x44 pixels) for easy clicking.",
    fix: "Make buttons/links at least 44x44 CSS pixels" 
  },
  "heading-order": { 
    level: "A", 
    criterion: "1.3.1", 
    severity: "medium", 
    title: "Incorrect Heading Hierarchy",
    description: "Heading levels should follow a logical order (h1, h2, h3, etc.) to create a proper document structure.",
    fix: "Use headings in sequential order without skipping levels" 
  },
  "html-has-lang": { 
    level: "A", 
    criterion: "3.1.1", 
    severity: "critical", 
    title: "Missing Language Declaration",
    description: "The HTML document must declare its primary language for screen readers and other assistive technologies.",
    fix: "Add lang attribute to the html element" 
  },
  "html-lang-valid": { 
    level: "A", 
    criterion: "3.1.1", 
    severity: "high", 
    title: "Invalid Language Code",
    description: "The language code specified in the lang attribute must be valid according to ISO standards.",
    fix: "Use a valid language code like 'en' for English" 
  },
  "image-redundant-alt": { 
    level: "A", 
    criterion: "1.1.1", 
    severity: "medium", 
    title: "Redundant Alternative Text",
    description: "Image alt text should not repeat information that's already available in the surrounding text.",
    fix: "Remove redundant text from alt attributes" 
  },
  "input-image-alt": { 
    level: "A", 
    criterion: "1.1.1", 
    severity: "critical", 
    title: "Image Input Missing Alt Text",
    description: "Image input elements (type='image') must have alt text to describe their function.",
    fix: "Add alt text to image input elements" 
  },
  "landmark-one-main": { 
    level: "A", 
    criterion: "1.3.1", 
    severity: "medium", 
    title: "Missing Main Landmark",
    description: "Pages should have exactly one main landmark to identify the primary content area.",
    fix: "Add a main element or role='main' to the page" 
  },
  "link-in-text-block": { 
    level: "A", 
    criterion: "1.4.1", 
    severity: "medium", 
    title: "Links Not Distinguished from Text",
    description: "Links within text blocks must be visually distinguishable from surrounding text.",
    fix: "Ensure links have sufficient color contrast and are underlined" 
  },
  "list": { 
    level: "A", 
    criterion: "1.3.1", 
    severity: "medium", 
    title: "Improper List Structure",
    description: "List elements must be properly structured with correct parent-child relationships.",
    fix: "Use proper list markup (ul, ol, dl) with li or dt/dd elements" 
  },
  "listitem": { 
    level: "A", 
    criterion: "1.3.1", 
    severity: "medium", 
    title: "List Items Not in Lists",
    description: "List item elements (li) must be contained within proper list elements (ul, ol, dl).",
    fix: "Ensure li elements are inside ul, ol, or dl elements" 
  },
  "meta-viewport": { 
    level: "A", 
    criterion: "1.4.4", 
    severity: "medium", 
    title: "Missing Viewport Meta Tag",
    description: "Pages must have a viewport meta tag to ensure proper display on mobile devices.",
    fix: "Add <meta name='viewport' content='width=device-width, initial-scale=1'>" 
  },
  "region": { 
    level: "A", 
    criterion: "1.3.1", 
    severity: "medium", 
    title: "Missing Region Labels",
    description: "Content regions should be labeled with headings or ARIA landmarks for better navigation.",
    fix: "Add headings or ARIA landmarks to content regions" 
  },
  "tabindex": { 
    level: "A", 
    criterion: "2.4.3", 
    severity: "medium", 
    title: "Incorrect Tab Order",
    description: "Tabindex values should not be used to create a custom tab order that confuses keyboard navigation.",
    fix: "Avoid positive tabindex values; use natural DOM order" 
  },
};

// Code fix suggestions
const codeFixes = {
  "alt-text": {
    wrong: '<img src="image.jpg">',
    correct: '<img src="image.jpg" alt="Descriptive text about the image">',
    explanation: "All images must have descriptive alt text for screen readers"
  },
  "image-alt": {
    wrong: '<img src="chart.png">',
    correct: '<img src="chart.png" alt="Monthly sales chart showing 25% growth">',
    explanation: "Images without alt text fail WCAG 1.1.1 (Non-text Content)"
  },
  "aria-allowed-attr": {
    wrong: '<div aria-invalid="true" role="button">Submit</div>',
    correct: '<button aria-invalid="true">Submit</button>',
    explanation: "Use valid ARIA attributes only on appropriate elements"
  },
  "aria-hidden-body": {
    wrong: '<body aria-hidden="true">',
    correct: '<body>',
    explanation: "Never hide the body element from screen readers"
  },
  "aria-required-attr": {
    wrong: '<div role="checkbox">Option</div>',
    correct: '<div role="checkbox" aria-checked="false" tabindex="0">Option</div>',
    explanation: "ARIA roles require specific attributes to function properly"
  },
  "aria-role": {
    wrong: '<div role="invalid-role">Content</div>',
    correct: '<div role="banner">Content</div>',
    explanation: "Use only valid ARIA role values from the specification"
  },
  "button-name": {
    wrong: '<button><icon></icon></button>',
    correct: '<button aria-label="Submit"><icon></icon></button> or <button>Submit</button>',
    explanation: "Buttons must have visible or accessible text/aria-label"
  },
  "color-contrast": {
    wrong: '<p style="color: #ccc; background: #fff;">Light gray text</p>',
    correct: '<p style="color: #333; background: #fff;">Dark gray text</p>',
    explanation: "Text must have contrast ratio of at least 4.5:1 (AA standard)"
  },
  "duplicate-id": {
    wrong: '<div id="header">Header 1</div><div id="header">Header 2</div>',
    correct: '<div id="header1">Header 1</div><div id="header2">Header 2</div>',
    explanation: "HTML element IDs must be unique within the document"
  },
  "empty-heading": {
    wrong: '<h1></h1>',
    correct: '<h1>Welcome to Our Website</h1>',
    explanation: "Heading elements must contain meaningful text content"
  },
  "form-field-multiple-labels": {
    wrong: '<label>Email:</label><label>Enter email:</label><input type="email">',
    correct: '<label for="email">Email:</label><input id="email" type="email">',
    explanation: "Form fields should have exactly one associated label"
  },
  "label": {
    wrong: '<input type="email"> Email:',
    correct: '<label for="email">Email:</label><input id="email" type="email">',
    explanation: "Form inputs must be associated with labels for accessibility"
  },
  "link-name": {
    wrong: '<a href="page.html">Click here</a>',
    correct: '<a href="page.html">Learn about our products</a>',
    explanation: "Links must have descriptive text, not generic 'Click here'"
  },
  "radio-group": {
    wrong: '<input type="radio" name="choice"><input type="radio" name="choice">',
    correct: '<fieldset><legend>Choose an option:</legend><input type="radio" name="choice" id="opt1"><label for="opt1">Option 1</label><input type="radio" name="choice" id="opt2"><label for="opt2">Option 2</label></fieldset>',
    explanation: "Related radio buttons must be grouped in a fieldset with legend"
  },
  "select-name": {
    wrong: '<select><option>Choose...</option></select>',
    correct: '<label for="country">Country:</label><select id="country"><option>Choose...</option></select>',
    explanation: "Select elements must have associated labels"
  },
  "target-size": {
    wrong: '<button style="width: 20px; height: 20px;">X</button>',
    correct: '<button style="width: 44px; height: 44px; min-width: 44px; min-height: 44px;">X</button>',
    explanation: "Interactive elements should be at least 44x44 pixels for easy clicking"
  },
  "heading-order": {
    wrong: '<h1>Title</h1><h3>Subtitle</h3>',
    correct: '<h1>Title</h1><h2>Subtitle</h2>',
    explanation: "Heading levels must be sequential (h1, h2, h3, not h1, h3)"
  },
  "html-has-lang": {
    wrong: '<html>',
    correct: '<html lang="en">',
    explanation: "HTML documents must declare their language for screen readers"
  },
  "html-lang-valid": {
    wrong: '<html lang="xx">',
    correct: '<html lang="en">',
    explanation: "Use valid language codes like 'en', 'es', 'fr', etc."
  },
  "image-redundant-alt": {
    wrong: '<img src="logo.png" alt="Company logo Company logo">',
    correct: '<img src="logo.png" alt="Company logo">',
    explanation: "Alt text should not repeat information already in surrounding text"
  },
  "input-image-alt": {
    wrong: '<input type="image" src="search.png">',
    correct: '<input type="image" src="search.png" alt="Search">',
    explanation: "Image input elements must have alt text describing their function"
  },
  "landmark-one-main": {
    wrong: '<div id="content">Main content here</div>',
    correct: '<main><h1>Main content here</h1></main>',
    explanation: "Pages need exactly one main landmark for primary content"
  },
  "link-in-text-block": {
    wrong: '<p>Visit our website for more info.</p>',
    correct: '<p>Visit our <a href="/info">website</a> for more info.</p>',
    explanation: "Links in text must be visually distinguishable (underlined, different color)"
  },
  "list": {
    wrong: '<div><div>Item 1</div><div>Item 2</div></div>',
    correct: '<ul><li>Item 1</li><li>Item 2</li></ul>',
    explanation: "Use proper semantic list markup instead of div elements"
  },
  "listitem": {
    wrong: '<ul><div>Item 1</div><div>Item 2</div></ul>',
    correct: '<ul><li>Item 1</li><li>Item 2</li></ul>',
    explanation: "List items must be <li> elements inside proper list containers"
  },
  "meta-viewport": {
    wrong: '<head><title>My Site</title></head>',
    correct: '<head><meta name="viewport" content="width=device-width, initial-scale=1"><title>My Site</title></head>',
    explanation: "Viewport meta tag ensures proper mobile display"
  },
  "region": {
    wrong: '<div>Navigation</div><div>Main Content</div>',
    correct: '<nav><ul><li><a href="/">Home</a></li></ul></nav><main><h1>Main Content</h1></main>',
    explanation: "Use semantic HTML elements or ARIA landmarks to identify content regions"
  },
  "tabindex": {
    wrong: '<button tabindex="5">Skip to content</button>',
    correct: '<button>Skip to content</button>',
    explanation: "Avoid positive tabindex values; use natural DOM order for keyboard navigation"
  }
};

function getPriorityScore(severity) {
  const scoreMap = {
    critical: 100,
    high: 75,
    medium: 50,
    low: 25
  };
  return scoreMap[severity] || 0;
}

function generatePatch(issue) {
  const fix = codeFixes[issue.id] || {};
  const before = fix.wrong || issue.htmlSnippet || `<!-- original code for ${issue.id} -->`;
  const after = fix.correct || fix.suggestedCode || issue.htmlSnippet || `<!-- corrected code for ${issue.id} -->`;

  return {
    before,
    after
  };
}

// Database functions
function saveSevereIssues(scanId, url, violations) {
  const severeViolations = violations.filter(v => v.severity === 'critical' || v.severity === 'high');

  severeViolations.forEach(violation => {
    const stmt = db.prepare(`INSERT INTO severe_issues
      (scan_id, url, issue_id, title, severity, wcag_level, criterion, description, html_snippet, nodes_affected)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    stmt.run(
      scanId,
      url,
      violation.id,
      violation.title,
      violation.severity,
      violation.wcagLevel,
      violation.criterion,
      violation.description,
      violation.htmlSnippet || '',
      violation.nodes || 0
    );
    stmt.finalize();
  });

  return severeViolations.length;
}

function saveScanLog(url, wcagScore, complianceLevel, totalIssues, severeIssuesCount, scanDuration) {
  const scanId = Date.now().toString() + Math.random().toString(36).substr(2, 9);

  const stmt = db.prepare(`INSERT INTO scan_logs
    (url, wcag_score, compliance_level, total_issues, severe_issues_count, scan_duration)
    VALUES (?, ?, ?, ?, ?, ?)`);

  stmt.run(url, wcagScore, complianceLevel, totalIssues, severeIssuesCount, scanDuration);
  stmt.finalize();

  return scanId;
}

function updateDashboardStats() {
  // Get total scans
  db.get("SELECT COUNT(*) as total FROM scan_logs", (err, row) => {
    if (err) return console.error('Error getting total scans:', err);

    const totalScans = row.total;

    // Get total severe issues
    db.get("SELECT COUNT(*) as total FROM severe_issues", (err, row) => {
      if (err) return console.error('Error getting severe issues:', err);

      const totalSevereIssues = row.total;

      // Get average WCAG score
      db.get("SELECT AVG(wcag_score) as avg FROM scan_logs", (err, row) => {
        if (err) return console.error('Error getting avg score:', err);

        const avgScore = row.avg || 0;

        // Get last scan date
        db.get("SELECT MAX(scan_date) as last_scan FROM scan_logs", (err, row) => {
          if (err) return console.error('Error getting last scan:', err);

          const lastScanDate = row.last_scan;

          // Update or insert dashboard stats
          db.run(`INSERT OR REPLACE INTO dashboard_stats (id, total_scans, total_severe_issues, avg_wcag_score, last_scan_date, updated_at)
                  VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                 [totalScans, totalSevereIssues, avgScore, lastScanDate]);
        });
      });
    });
  });
}

// Dashboard logging function
function logDashboardAccess(endpoint, req, res, responseTime) {
  const stmt = db.prepare(`INSERT INTO dashboard_logs
    (endpoint, method, ip_address, user_agent, query_params, response_status, response_time)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

  stmt.run(
    endpoint,
    req.method,
    req.ip || req.connection.remoteAddress || 'unknown',
    req.get('User-Agent') || 'unknown',
    JSON.stringify(req.query),
    res.statusCode,
    responseTime
  );
  stmt.finalize();
}

// Calculate WCAG 2.1 Score (0-100)
function calculateWCAGScore(violations) {
  let totalScore = 100;
  let criticalIssues = 0;
  let highIssues = 0;
  let mediumIssues = 0;

  violations.forEach(v => {
    const rule = wcagRules[v.id];
    if (!rule) return;

    switch (rule.severity) {
      case "critical":
        criticalIssues++;
        totalScore -= 10;
        break;
      case "high":
        highIssues++;
        totalScore -= 5;
        break;
      case "medium":
        mediumIssues++;
        totalScore -= 2;
        break;
    }
  });

  return Math.max(0, Math.min(100, totalScore));
}

// Get WCAG compliance level
function getComplianceLevel(score) {
  if (score >= 90) return { level: "AAA", color: "#10b981", status: "Excellent" };
  if (score >= 80) return { level: "AA", color: "#f59e0b", status: "Good" };
  if (score >= 70) return { level: "A", color: "#f97316", status: "Fair" };
  return { level: "Below A", color: "#ef4444", status: "Critical" };
}

// Generate AI-powered fix suggestions using Gemini
async function generateGeminiSuggestion(issue) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Gemini API key is not set.");
  }

  const model = process.env.GEMINI_MODEL || "gemini-pro";
  const prompt = `You are an expert accessibility consultant. Provide a specific, actionable code fix for this WCAG accessibility issue.

ISSUE DETAILS:
- Rule ID: ${issue.id}
- Title: ${issue.title}
- Description: ${issue.description}
- WCAG Level: ${issue.wcagLevel}
- Severity: ${issue.severity}
- Element Snippet: ${issue.htmlSnippet || 'N/A'}

Please provide:
1. A brief explanation of why this fix is needed
2. The exact corrected HTML/CSS code to replace the old snippet
3. If applicable, show the wrong code first

Return your response as valid JSON with these exact keys:
{
  "explanation": "Why this fix works",
  "suggestedCode": "The exact HTML/CSS code to replace the old one",
  "wrong": "The problematic HTML/CSS code (optional)",
  "fileType": "HTML"
}

Only return the JSON object; do not include any extra text or markdown fences.`;

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: prompt
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 500
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API request failed: ${response.status} ${errorText}`);
  }

  const payload = await response.json();
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text || payload?.candidates?.[0]?.content?.[0]?.text || "";

  function parseResponse(raw) {
    try {
      return JSON.parse(raw);
    } catch {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      return null;
    }
  }

  const parsed = parseResponse(text);
  if (parsed) {
    return {
      explanation: parsed.explanation || parsed.description || issue.description,
      suggestedCode: parsed.suggestedCode || parsed.fix || parsed.correct || "See code example below",
      wrong: parsed.wrong || parsed.problematicCode || "Problematic code pattern",
      fileType: parsed.fileType || "HTML"
    };
  }

  // Fallback to predefined fix if AI response is not valid JSON
  const predefined = codeFixes[issue.id];
  return predefined || {
    explanation: issue.description,
    suggestedCode: `See WCAG guidelines for ${issue.id}`,
    wrong: "",
    fileType: "HTML"
  };
}


async function generateAISuggestion(issue) {
  try {
    const predefinedFix = codeFixes[issue.id];

    if (process.env.GEMINI_API_KEY) {
      return await generateGeminiSuggestion(issue);
    }

    return predefinedFix || {
      explanation: issue.description,
      suggestedCode: `See WCAG guidelines for ${issue.id}`,
      fileType: "HTML"
    };
  } catch (err) {
    console.warn("⚠️ AI suggestion unavailable:", err.message);
    const fallback = codeFixes[issue.id] || { explanation: "AI service unavailable" };
    return {
      explanation: fallback.explanation || fallback.description || "AI service unavailable",
      suggestedCode: fallback.correct || fallback.fix || fallback.suggestedCode || "See the issue description above",
      wrong: fallback.wrong || "",
      fileType: "HTML"
    };
  }
}

// Immediate AI-powered fix generation
async function generateAIFix(issueData) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Gemini API key not configured");
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-pro" });

  const prompt = `You are an accessibility expert. Provide a quick, practical fix for this WCAG issue.

Issue: ${issueData.title || issueData.id}
Description: ${issueData.description}
Current Code: ${issueData.htmlSnippet || "Not provided"}

Provide ONLY valid JSON (no markdown, no explanation outside JSON):
{
  "fixedCode": "<the exact corrected HTML>",
  "explanation": "Why this fix works"
}`;

  try {
    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();

    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        fixedCode: parsed.fixedCode || "",
        explanation: parsed.explanation || "Fix applied"
      };
    }

    // Fallback to predefined fix
    const predefined = codeFixes[issueData.id];
    return {
      fixedCode: predefined?.correct || predefined?.suggestedCode || issueData.htmlSnippet || "",
      explanation: predefined?.explanation || "Accessibility fix applied"
    };
  } catch (err) {
    console.warn("⚠️ AI fix generation failed:", err.message);
    const predefined = codeFixes[issueData.id];
    return {
      fixedCode: predefined?.correct || predefined?.suggestedCode || "",
      explanation: predefined?.explanation || "See WCAG guidelines for proper implementation"
    };
  }
}

// Main Scan API Route
app.post("/scan", async (req, res) => {
  const { url } = req.body;

  const formattedUrl = url && url.startsWith("http") ? url : `https://${url}`;
  const cacheKey = formattedUrl;
  const cached = scanCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    console.log("♻️ Returning cached scan for", formattedUrl);
    return res.json({ ...cached.response, cached: true });
  }

  try {
    console.log("🔍 Scanning:", formattedUrl);

    let browser;
    let page;
    let results;
    let pageHtml = "";

    try {
      // Launch browser with improved settings
      browser = await puppeteer.launch({
        headless: "new",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled", // Hide automation
          "--disable-dev-shm-usage" // Reduce memory issues
        ]
      });

      page = await browser.newPage();
      
      // Set user agent to avoid blocking
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      );

      // Add extra headers to avoid bot detection
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9,en-GB;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://www.google.com/'
      });

      // Set viewport
      await page.setViewport({ width: 1280, height: 720 });

      console.log("📄 Navigating to URL...");
      
      // Simple, direct navigation with reasonable timeout
      try {
        await page.goto(formattedUrl, { 
          waitUntil: "domcontentloaded", 
          timeout: 30000 // Single 30-second timeout
        });
        console.log(`  ✅ Page loaded successfully`);
      } catch (err) {
        // If domcontentloaded fails, try with networkidle2 (less strict)
        console.log(`  ⚠️ domcontentloaded failed, trying networkidle2...`);
        try {
          await page.goto(formattedUrl, { 
            waitUntil: "networkidle2", 
            timeout: 20000 
          });
          console.log(`  ✅ Page loaded with networkidle2`);
        } catch (err2) {
          // Final attempt - just wait for basic HTML
          console.log(`  ⚠️ Trying basic navigation...`);
          await Promise.race([
            page.goto(formattedUrl, { timeout: 15000 }),
            new Promise(resolve => setTimeout(resolve, 15000))
          ]).catch(e => {
            throw {
              type: "NAVIGATION_ERROR",
              message: `Failed to load website after multiple attempts: ${err.message}`,
              suggestions: [
                "Check if the URL is correct (e.g., example.com or https://example.com)",
                "The website might be blocking automated access",
                "The website might be temporarily down",
                "Try adding http:// or https:// prefix",
                "Check your internet connection"
              ]
            };
          });
        }
      }

      console.log("✅ Page loaded, running accessibility scan...");

      // Inject and run axe-core
      await page.evaluate(axeSource);
      
      // Run axe scan with timeout
      const axeExecutionPromise = page.evaluate(async () => {
        return await axe.run();
      });

      const axeTimeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Axe scan timeout")), 20000) // Reduced from 30000
      );

      results = await Promise.race([axeExecutionPromise, axeTimeoutPromise]);
      pageHtml = await page.content();

      await browser.close();

    } catch (err) {
      // Close browser if still open
      if (browser) {
        try {
          await browser.close();
        } catch (e) {
          console.error("Error closing browser:", e.message);
        }
      }

      // Detailed error detection
      let errorResponse = {
        error: err.message,
        url: formattedUrl,
        type: err.type || "UNKNOWN_ERROR"
      };

      if (err.type) {
        errorResponse.suggestions = err.suggestions;
      } else {
        // Detect error type from message
        const errorMsg = err.message.toLowerCase();

        if (errorMsg.includes("timeout") || errorMsg.includes("timed out")) {
          errorResponse.type = "TIMEOUT";
          errorResponse.suggestions = [
            "🕐 The website is taking too long to load",
            "Try accessing the website manually to confirm it's online",
            "The website might be slow or overloaded",
            "Check your internet connection"
          ];
        } else if (errorMsg.includes("refused") || errorMsg.includes("connect econnrefused")) {
          errorResponse.type = "CONNECTION_REFUSED";
          errorResponse.suggestions = [
            "❌ Cannot connect to the website",
            "Check if the URL is correct",
            "The website might be offline or blocked",
            "Try again in a few moments"
          ];
        } else if (errorMsg.includes("enotfound")) {
          errorResponse.type = "DNS_ERROR";
          errorResponse.suggestions = [
            "🔍 Cannot find the domain (DNS error)",
            "Check the domain name spelling",
            "The website might not exist",
            "Try with http:// or https:// prefix"
          ];
        } else if (errorMsg.includes("certificate") || errorMsg.includes("ssl")) {
          errorResponse.type = "SSL_ERROR";
          errorResponse.suggestions = [
            "🔐 SSL/Certificate error",
            "The website's security certificate might be invalid",
            "Try accessing with http:// instead of https://",
            "Check if the domain is correct"
          ];
        } else if (errorMsg.includes("403") || errorMsg.includes("forbidden")) {
          errorResponse.type = "ACCESS_FORBIDDEN";
          errorResponse.suggestions = [
            "🚫 Access forbidden by the website",
            "The website is blocking automated scanning",
            "Try accessing the website manually",
            "Some websites don't allow bot access"
          ];
        } else if (errorMsg.includes("404")) {
          errorResponse.type = "NOT_FOUND";
          errorResponse.suggestions = [
            "📍 Page not found (404 error)",
            "Check if the URL is correct",
            "The website might have moved"
          ];
        } else if (errorMsg.includes("proxy")) {
          errorResponse.type = "PROXY_ERROR";
          errorResponse.suggestions = [
            "🌐 Proxy/Network configuration error",
            "Check your internet connection",
            "You might be behind a proxy or firewall",
            "Try connecting to a different network"
          ];
        }
      }

      console.error("❌ Error:", errorResponse);
      return res.status(500).json(errorResponse);
    }

    // Calculate WCAG 2.1 Score
    const wcagScore = calculateWCAGScore(results.violations);
    const compliance = getComplianceLevel(wcagScore);

    // Enhance violations with metadata, HTML snippets, and fixes
    const enhancedViolations = results.violations.map((v, i) => {
      const ruleData = wcagRules[v.id] || { 
        level: "Unknown", 
        criterion: "N/A", 
        severity: "medium",
        title: v.id.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()), // Fallback title
        description: v.description, // Fallback to axe description
        fix: "See WCAG guidelines for proper implementation"
      };
      const fix = codeFixes[v.id];
      const htmlSnippet = v.nodes?.[0]?.html || v.nodes?.[0]?.target?.join(' ') || "";

      return {
        id: v.id,
        index: i,
        title: ruleData.title,
        description: ruleData.description,
        impact: v.impact,
        severity: ruleData.severity,
        wcagLevel: ruleData.level,
        criterion: ruleData.criterion,
        nodes: v.nodes.length,
        htmlSnippet,
        patch: generatePatch({ id: v.id, htmlSnippet }),
        priorityScore: getPriorityScore(ruleData.severity),
        fix: fix || { explanation: ruleData.fix, suggestedCode: `See WCAG guidelines for ${v.id}` },
        help: v.help,
        helpUrl: v.helpUrl
      };
    });

    enhancedViolations.sort((a, b) => 
      getPriorityScore(b.severity) - getPriorityScore(a.severity)
    );

    const responsePayload = {
      url: formattedUrl,
      wcagScore,
      compliance,
      totalIssues: results.violations.length,
      violations: enhancedViolations.slice(0, 50), // Limit to top 50 issues
      passes: results.passes.length,
      scanDate: new Date().toISOString()
    };

    // Save scan data to database
    const scanStartTime = Date.now();
    const scanId = saveScanLog(
      formattedUrl,
      wcagScore,
      compliance.level,
      results.violations.length,
      0, // Will update after saving severe issues
      Date.now() - scanStartTime
    );

    // Save severe issues and update the scan log
    const severeCount = saveSevereIssues(scanId, formattedUrl, enhancedViolations);
    db.run("UPDATE scan_logs SET severe_issues_count = ? WHERE id = ?", [severeCount, scanId]);

    // Update dashboard stats
    updateDashboardStats();

    scanCache.set(cacheKey, {
      expiresAt: Date.now() + 5 * 60 * 1000,
      response: responsePayload,
      pageHtml
    });

    res.json(responsePayload);

  } catch (err) {
    console.error("❌ Unexpected Error:", err);
    res.status(500).json({
      error: err.message || "Something went wrong",
      type: "UNEXPECTED_ERROR",
      url: formattedUrl,
      suggestions: [
        "Check your internet connection",
        "Try a different website",
        "Check the server logs for more details"
      ]
    });
  }
});

// Detailed fix suggestions endpoint
app.post("/fix-suggestion", async (req, res) => {
  const { issueId, title, description, htmlSnippet, wcagLevel, severity, url } = req.body;
  try {
    const suggestion = await generateAISuggestion({ 
      id: issueId,
      title: title || issueId,
      description: description || "No description provided",
      htmlSnippet: htmlSnippet || "",
      wcagLevel: wcagLevel || "Unknown",
      severity: severity || "Unknown",
      url: url || ""
    });
    res.json(suggestion);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Immediate AI Fix endpoint
app.post("/fix", async (req, res) => {
  const { id, title, description, htmlSnippet } = req.body;
  
  if (!id || !description) {
    return res.status(400).json({ error: "Missing id or description" });
  }

  try {
    const fix = await generateAIFix({
      id,
      title: title || id,
      description,
      htmlSnippet: htmlSnippet || ""
    });
    res.json(fix);
  } catch (err) {
    console.error("Error generating AI fix:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/patch-fix", async (req, res) => {
  const { url, issueId, htmlSnippet, suggestedCode } = req.body;
  const formattedUrl = url && url.startsWith("http") ? url : `https://${url}`;
  const cached = scanCache.get(formattedUrl);

  if (!cached || !cached.pageHtml) {
    return res.status(400).json({ error: "No cached scan HTML available. Scan the URL first." });
  }

  if (!htmlSnippet || !suggestedCode) {
    return res.status(400).json({ error: "Missing htmlSnippet or suggestedCode." });
  }

  const originalHtml = cached.pageHtml;
  let patchedHtml = originalHtml;
  let applied = false;

  try {
    const dom = new JSDOM(originalHtml);
    const document = dom.window.document;
    const normalizedSnippet = htmlSnippet.trim();
    const targetElements = Array.from(document.querySelectorAll("*")).filter(node => {
      return node.outerHTML.trim() === normalizedSnippet || node.outerHTML.replace(/\s+/g, ' ').trim() === normalizedSnippet.replace(/\s+/g, ' ').trim();
    });

    if (targetElements.length > 0) {
      targetElements[0].outerHTML = suggestedCode;
      patchedHtml = dom.serialize();
      applied = true;
    } else if (originalHtml.includes(normalizedSnippet)) {
      patchedHtml = originalHtml.replace(normalizedSnippet, suggestedCode);
      applied = patchedHtml !== originalHtml;
    } else {
      const reducedSnippet = normalizedSnippet.replace(/\s+/g, ' ').trim();
      const reducedHtml = originalHtml.replace(/\s+/g, ' ').trim();
      if (reducedHtml.includes(reducedSnippet)) {
        patchedHtml = originalHtml.replace(new RegExp(reducedSnippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), suggestedCode);
        applied = patchedHtml !== originalHtml;
      }
    }
  } catch (err) {
    console.warn("⚠️ Patch-fix DOM transform failed:", err.message);
  }

  if (!applied || patchedHtml === originalHtml) {
    return res.status(500).json({ error: "Could not apply the patch automatically." });
  }

  res.setHeader("Content-Disposition", "attachment; filename=accessibility-patch.html");
  res.setHeader("Content-Type", "text/html");
  res.send(patchedHtml);
});

// Dashboard API endpoints
app.get("/api/dashboard/stats", (req, res) => {
  const startTime = Date.now();

  db.get("SELECT * FROM dashboard_stats WHERE id = 1", (err, row) => {
    const responseTime = Date.now() - startTime;

    if (err) {
      logDashboardAccess('/api/dashboard/stats', req, res, responseTime);
      return res.status(500).json({ error: "Database error" });
    }

    if (!row) {
      logDashboardAccess('/api/dashboard/stats', req, res, responseTime);
      return res.json({
        totalScans: 0,
        totalSevereIssues: 0,
        avgWcagScore: 0,
        lastScanDate: null
      });
    }

    logDashboardAccess('/api/dashboard/stats', req, res, responseTime);
    res.json({
      totalScans: row.total_scans,
      totalSevereIssues: row.total_severe_issues,
      avgWcagScore: Math.round(row.avg_wcag_score * 100) / 100,
      lastScanDate: row.last_scan_date
    });
  });
});

app.get("/api/dashboard/recent-scans", (req, res) => {
  const startTime = Date.now();
  const limit = parseInt(req.query.limit) || 10;

  db.all("SELECT * FROM scan_logs ORDER BY scan_date DESC LIMIT ?", [limit], (err, rows) => {
    const responseTime = Date.now() - startTime;

    if (err) {
      logDashboardAccess('/api/dashboard/recent-scans', req, res, responseTime);
      return res.status(500).json({ error: "Database error" });
    }

    logDashboardAccess('/api/dashboard/recent-scans', req, res, responseTime);
    res.json(rows.map(row => ({
      id: row.id,
      url: row.url,
      wcagScore: row.wcag_score,
      complianceLevel: row.compliance_level,
      totalIssues: row.total_issues,
      severeIssuesCount: row.severe_issues_count,
      scanDate: row.scan_date,
      scanDuration: row.scan_duration
    })));
  });
});

app.get("/api/dashboard/severe-issues", (req, res) => {
  const startTime = Date.now();
  const limit = parseInt(req.query.limit) || 20;

  db.all(`
    SELECT si.*, sl.wcag_score, sl.compliance_level
    FROM severe_issues si
    LEFT JOIN scan_logs sl ON si.scan_id = sl.id
    ORDER BY si.scan_date DESC
    LIMIT ?
  `, [limit], (err, rows) => {
    const responseTime = Date.now() - startTime;

    if (err) {
      logDashboardAccess('/api/dashboard/severe-issues', req, res, responseTime);
      return res.status(500).json({ error: "Database error" });
    }

    logDashboardAccess('/api/dashboard/severe-issues', req, res, responseTime);
    res.json(rows.map(row => ({
      id: row.id,
      scanId: row.scan_id,
      url: row.url,
      issueId: row.issue_id,
      title: row.title,
      severity: row.severity,
      wcagLevel: row.wcag_level,
      criterion: row.criterion,
      description: row.description,
      htmlSnippet: row.html_snippet,
      nodesAffected: row.nodes_affected,
      scanDate: row.scan_date,
      wcagScore: row.wcag_score,
      complianceLevel: row.compliance_level
    })));
  });
});

app.get("/api/dashboard/issues-by-type", (req, res) => {
  const startTime = Date.now();

  db.all(`
    SELECT issue_id, title, severity, COUNT(*) as count
    FROM severe_issues
    GROUP BY issue_id, title, severity
    ORDER BY count DESC
    LIMIT 10
  `, (err, rows) => {
    const responseTime = Date.now() - startTime;

    if (err) {
      logDashboardAccess('/api/dashboard/issues-by-type', req, res, responseTime);
      return res.status(500).json({ error: "Database error" });
    }

    logDashboardAccess('/api/dashboard/issues-by-type', req, res, responseTime);
    res.json(rows);
  });
});

// Dashboard logs API endpoint
app.get("/api/dashboard/logs", requireDeveloperAuth, (req, res) => {
  const startTime = Date.now();
  const limit = parseInt(req.query.limit) || 50;

  db.all(`
    SELECT * FROM dashboard_logs
    ORDER BY timestamp DESC
    LIMIT ?
  `, [limit], (err, rows) => {
    const responseTime = Date.now() - startTime;

    if (err) {
      logDashboardAccess('/api/dashboard/logs', req, res, responseTime);
      return res.status(500).json({ error: "Database error" });
    }

    logDashboardAccess('/api/dashboard/logs', req, res, responseTime);
    res.json(rows.map(row => ({
      id: row.id,
      endpoint: row.endpoint,
      method: row.method,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      queryParams: JSON.parse(row.query_params || '{}'),
      responseStatus: row.response_status,
      responseTime: row.response_time,
      timestamp: row.timestamp
    })));
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ AccessiScan running at http://localhost:${PORT}`);
  console.log("📋 WCAG 2.1 Accessibility Scanner with AI Suggestions");
});