# Hershenberg Group Listings Scraper

## Overview
This Apify actor scrapes real estate listings from Brandon Hooley's agent page on the Hershenberg Group website. It uses Playwright with stealth mode to navigate the page, interact with dynamic elements, and extract comprehensive listing data.

## Features
- Headless browser automation with Playwright
- Anti-detection measures using playwright-stealth
- Dynamic content loading via button clicks
- Automatic pagination handling ("SEE MORE" button)
- Residential proxy support
- Comprehensive error handling and retry logic
- Natural scrolling behavior

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `targetUrl` | String | Yes | `https://www.hershenberggroup.com/team/brandon-hooley` | The URL of the agent page to scrape |
| `maxRetries` | Integer | No | 3 | Maximum number of retries for failed selectors |
| `scrollDelay` | Integer | No | 1500 | Delay in milliseconds between scroll actions |
| `useProxy` | Boolean | No | true | Enable Apify residential proxy |
| `proxyConfiguration` | Object | No | - | Proxy configuration settings |

## Output Format

The actor stores extracted listings in the Apify Dataset. Each listing contains:

```json
{
  "title": "1234 Maple Drive",
  "price": "$750,000",
  "sqft": "2,350",
  "beds": 4,
  "baths": 3,
  "images": [
    "https://site.com/image1.jpg",
    "https://site.com/image2.jpg"
  ],
  "listingUrl": "https://site.com/listing/1234-maple",
  "agent": "Brandon Hooley",
  "timestamp": "2025-06-16T22:30:00Z"
}
```

## Workflow

1. **Navigation**: Opens the target URL with desktop viewport
2. **Initial Scroll**: Scrolls to middle of page to trigger content loading
3. **All Listings**: Clicks "ALL LISTINGS" button to show all properties
4. **Load More**: Clicks "SEE MORE" repeatedly until all listings are loaded
5. **Extraction**: Parses all listing cards for property details
6. **Storage**: Saves results to Apify Dataset

## Error Handling

- **Retry Logic**: Failed selectors are retried up to `maxRetries` times
- **Captcha**: If captcha is detected, the actor logs warning and proceeds
- **No Data**: If no listings found, saves debug screenshot to key-value store
- **Network Errors**: Wrapped in try/catch blocks with detailed logging

## Local Development

```bash
# Install dependencies
npm install

# Run locally with Apify CLI
apify run -p

# Or run directly
npm start
```

## Deployment

1. Push to Apify platform:
```bash
apify push
```

2. Or build and deploy manually:
```bash
apify login
apify create hershenberg-group-scraper
apify push
```

## Usage Notes

- The actor is optimized for the current Hershenberg Group website structure
- Selectors use flexible patterns to handle minor DOM changes
- Rate limiting is implemented via scroll delays
- Resource blocking (fonts, media) improves performance
- Debug screenshots are saved when no data is found

## License

ISC License - See LICENSE file for details