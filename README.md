# 🚀 AccessiScan - AI-Powered WCAG 2.1 Accessibility Scanner

An intelligent web accessibility analysis tool that scans websites for WCAG 2.1 compliance issues and provides AI-powered code fix suggestions with persistent database storage.

## ✨ Features

- **🎯 WCAG 2.1 Compliance Scoring** - Get a 0-100 accessibility score based on WCAG 2.1 standards
- **🔍 Automated Issue Detection** - Identifies 50+ accessibility issues using axe-core
- **💡 AI-Powered Fix Suggestions** - Get specific code fixes and explanations for each issue
- **📊 Detailed Analytics** - Breakdown by severity (Critical, High, Medium, Low)
- **🏷️ WCAG Criterion Mapping** - Shows which WCAG criterion each issue violates
- **💻 Code Examples** - Before/after code samples for common accessibility fixes
- **🎨 Professional UI** - Beautiful, responsive dashboard for results visualization
- **🗄️ Database Storage** - Persistent storage of severe issues and scan history
- **📈 Analytics Dashboard** - Track historical data and severe issue patterns
- **🔥 Severe Issue Tracking** - Automatic logging of critical and high-priority issues

## 🗄️ Database Features

- **SQLite Database** - Lightweight, file-based database (no external server required)
- **Severe Issues Log** - Automatically stores all critical and high-severity issues
- **Scan History** - Complete history of all accessibility scans performed
- **Dashboard Analytics** - Real-time statistics and trends
- **Issue Pattern Analysis** - Track common accessibility problems across sites

### Database Tables

1. **severe_issues** - Stores critical and high-priority accessibility issues
2. **scan_logs** - Complete scan history with WCAG scores and metadata
3. **dashboard_stats** - Aggregated statistics for dashboard display

## 📋 Accessibility Issues Detected

The scanner identifies issues including:
- **Image Alt Text** (criterion 1.1.1)
- **Button/Link Names** (criterion 4.1.2)
- **Form Labels** (criterion 4.1.3)
- **Color Contrast** (criterion 1.4.3)
- **Heading Order** (criterion 1.3.1)
- **ARIA Attributes** (criterion 4.1.2)
- **Duplicate IDs** (criterion 4.1.1)
- **Form Field Groups** (criterion 1.3.1)
- And 40+ more WCAG criteria...

## 🚀 Quick Start

### Prerequisites
- Node.js 16+
- npm or yarn

### Installation

1. Clone or download this repository
2. Install dependencies and setup database:
```bash
npm install
# Database is automatically created when server starts
```

Or use the setup script:
```bash
# Windows
setup-db.bat

# Linux/Mac
chmod +x setup-db.sh
./setup-db.sh
```

3. **(Optional) Set up Gemini AI Integration**:
   - Copy `.env.example` to `.env`
   - Add your Gemini API key from Google Cloud
   - The tool works without an API key (uses predefined fixes)

### Running the Scanner

```bash
npm start
```

4. Open your browser to `http://localhost:3000`

### Database Files

- `accessiscan.db` - SQLite database file (created automatically)
- Contains tables for severe issues, scan logs, and dashboard statistics
```

The scanner will start at `http://localhost:3000`

## 💻 Usage

1. Open `http://localhost:3000` in your browser
2. Enter a website URL (e.g., `example.com` or `https://example.com`)
3. Click **Scan**
4. View detailed results including:
   - **WCAG Compliance Level** (A, AA, AAA)
   - **Accessibility Score** (0-100)
   - **Issue Severity Breakdown**
   - **Code Fix Suggestions** for each issue
   - **WCAG Criterion References**

## 📊 Understanding Your Score

| Score | Level | Status |
|-------|-------|--------|
| 90-100 | AAA | Excellent |
| 80-89 | AA | Good |
| 70-79 | A | Fair |
| < 70 | Below A | Critical |

## 🔧 API Endpoints

### POST /scan
Scans a website for accessibility issues.

**Request:**
```json
{
  "url": "example.com"
}
```

**Response:**
```json
{
  "url": "https://example.com",
  "wcagScore": 85,
  "compliance": {
    "level": "AA",
    "status": "Good",
    "color": "#f59e0b"
  },
  "totalIssues": 12,
  "violations": [
    {
      "id": "alt-text",
      "severity": "critical",
      "wcagLevel": "A",
      "criterion": "1.1.1",
      "description": "Images must have alternative text",
      "fix": {
        "explanation": "Add alt text to all images...",
        "correct": "<img alt='Description' src='...'>"
      },
      "nodes": 5
    }
  ],
  "passes": 24
}
```

### POST /fix-suggestion
Get AI-powered suggestions for a specific issue (requires Gemini API key).

**Request:**
```json
{
  "issueId": "alt-text"
}
```

## 🎯 Common Issues & Fixes

### 1. Missing Alt Text
**Problem:** Images lack descriptive alternative text
```html
<!-- ❌ Wrong -->
<img src="chart.jpg">

<!-- ✅ Correct -->
<img src="chart.jpg" alt="Monthly sales chart showing 25% growth">
```

### 2. Inaccessible Buttons
**Problem:** Buttons lack readable names
```html
<!-- ❌ Wrong -->
<button><icon></icon></button>

<!-- ✅ Correct -->
<button aria-label="Submit form"><icon></icon></button>
```

### 3. Form Labels Missing
**Problem:** Form inputs not associated with labels
```html
<!-- ❌ Wrong -->
Email: <input type="email">

<!-- ✅ Correct -->
<label for="email">Email:</label>
<input id="email" type="email">
```

### 4. Low Color Contrast
**Problem:** Text difficult to read
```html
<!-- ❌ Wrong -->
<p style="color: #ccc; background: #fff;">Light text</p>

<!-- ✅ Correct -->
<p style="color: #333; background: #fff;">Dark text</p>
```

## 🤖 AI-Powered Suggestions (Optional)

When you add your Gemini API key:
- Get smarter, context-aware fix suggestions
- Receive explanations of WCAG criteria
- Get code examples specific to your issues

To enable:
1. Create a `.env` file
2. Add: `GEMINI_API_KEY=your-gemini-api-key-here`
3. Restart the server

## 📚 WCAG 2.1 Levels Explained

- **Level A** - Basic accessibility compliance
- **Level AA** - Enhanced accessibility (recommended)
- **Level AAA** - Highest accessibility standard

The scanner evaluates against all three levels.

## 🛠️ Technology Stack

- **Backend**: Express.js
- **Browser Automation**: Puppeteer
- **Accessibility Testing**: axe-core
- **AI**: Gemini API (optional)
- **Frontend**: Vanilla JavaScript with modern CSS

## 📝 Project Structure

```
accessiscan/
├── server.js          # Express backend & scanning engine
├── index.html         # Web interface
├── package.json       # Dependencies
├── .env.example       # Environment configuration template
└── README.md          # This file
```

## 🚨 Troubleshooting

### "Failed to Scan Website" Error?

The scanner now provides detailed error diagnostics! Check the error type and suggestions displayed on screen.

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for a complete guide covering:

- **CONNECTION_REFUSED:** Website offline or unreachable
- **DNS_ERROR:** Domain not found or doesn't exist
- **TIMEOUT:** Website taking too long to load
- **SSL_ERROR:** Security certificate issues
- **ACCESS_FORBIDDEN:** Website blocking automated access
- **NOT_FOUND:** 404 - Page doesn't exist
- **PROXY_ERROR:** Network/firewall issues

Each error type includes:
- ✅ What it means
- ✅ Why it happens
- ✅ How to fix it
- ✅ Example solutions

**Quick test:** Try scanning `google.com` to verify the scanner works.

## 📖 References

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [axe-core Documentation](https://github.com/dequelabs/axe-core/blob/develop/README.md)
- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- [Gemini API Documentation](https://developers.generativeai.google/api/gemini)

## 📄 License

ISC

## 🤝 Contributing

Feel free to submit issues and enhancement requests!

---

**Made with ♥️ for a more accessible web**

