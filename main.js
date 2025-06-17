import { Actor, log } from 'apify';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'playwright-extra-plugin-stealth';

// Add stealth plugin to avoid detection
chromium.use(StealthPlugin());

Actor.main(async () => {
    // Get input configuration
    const input = await Actor.getInput() || {};
    const {
        targetUrl = 'https://www.hershenberggroup.com/team/brandon-hooley',
        maxRetries = 3,
        scrollDelay = 1500,
        useProxy = true,
        proxyConfiguration
    } = input;

    log.info('Starting Hershenberg Group listings scraper', { targetUrl });

    // Configure browser launch options
    const launchOptions = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    };

    // Setup proxy if enabled
    if (useProxy && proxyConfiguration) {
        const proxyUrl = await Actor.createProxyUrl(proxyConfiguration);
        launchOptions.proxy = { server: proxyUrl };
        log.info('Using proxy configuration');
    }

    // Launch browser
    const browser = await chromium.launch(launchOptions);
    
    try {
        const context = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
            userAgent: getRandomUserAgent()
        });

        const page = await context.newPage();
        
        // Enable request interception to block unnecessary resources
        await page.route('**/*', (route) => {
            const resourceType = route.request().resourceType();
            if (['font', 'media'].includes(resourceType)) {
                route.abort();
            } else {
                route.continue();
            }
        });

        // Navigate to target URL
        log.info('Navigating to target page');
        await page.goto(targetUrl, { 
            waitUntil: 'networkidle',
            timeout: 60000 
        });

        // Natural scrolling function
        const smoothScroll = async (target) => {
            await page.evaluate(async (scrollTarget) => {
                const element = scrollTarget === 'bottom' 
                    ? document.body 
                    : document.querySelector(scrollTarget);
                
                if (element) {
                    element.scrollIntoView({ 
                        behavior: 'smooth', 
                        block: scrollTarget === 'bottom' ? 'end' : 'center' 
                    });
                }
            }, target);
            await page.waitForTimeout(scrollDelay);
        };

        // Scroll to middle of page to load content
        log.info('Scrolling to middle of page');
        await smoothScroll('body');
        await page.waitForTimeout(2000);

        // Click "ALL LISTINGS" button with retries
        const allListingsClicked = await clickWithRetry(
            page, 
            'button:has-text("ALL LISTINGS"), a:has-text("ALL LISTINGS")', 
            maxRetries,
            'ALL LISTINGS button'
        );

        if (!allListingsClicked) {
            log.warning('Could not find ALL LISTINGS button, proceeding with available content');
        }

        // Scroll to bottom
        log.info('Scrolling to bottom of page');
        await smoothScroll('bottom');
        await page.waitForTimeout(2000);

        // Click "SEE MORE" repeatedly until all listings are loaded
        let seeMoreCount = 0;
        let hasMoreListings = true;

        while (hasMoreListings) {
            const seeMoreButton = await page.$('button:has-text("SEE MORE"), a:has-text("SEE MORE")');
            
            if (seeMoreButton) {
                const isVisible = await seeMoreButton.isVisible();
                if (isVisible) {
                    log.info(`Clicking SEE MORE button (${seeMoreCount + 1})`);
                    await seeMoreButton.click();
                    seeMoreCount++;
                    await page.waitForTimeout(3000); // Wait for new listings to load
                    await smoothScroll('bottom');
                } else {
                    hasMoreListings = false;
                }
            } else {
                hasMoreListings = false;
            }

            // Safety limit to prevent infinite loops
            if (seeMoreCount >= 50) {
                log.warning('Reached maximum SEE MORE clicks limit');
                break;
            }
        }

        log.info(`Clicked SEE MORE ${seeMoreCount} times, extracting listings`);

        // Extract all listings data
        const listings = await page.evaluate(() => {
            const listingElements = document.querySelectorAll('[class*="listing"], [class*="property"], article, .card');
            const results = [];
            
            listingElements.forEach((listing) => {
                try {
                    // Extract title/address
                    const titleElement = listing.querySelector('[class*="title"], [class*="address"], h2, h3, h4');
                    const title = titleElement ? titleElement.textContent.trim() : '';

                    // Extract price
                    const priceElement = listing.querySelector('[class*="price"], [class*="cost"], [data-price]');
                    const price = priceElement ? priceElement.textContent.trim() : '';

                    // Extract square footage
                    const sqftElement = listing.querySelector('[class*="sqft"], [class*="square"], [class*="area"]');
                    const sqft = sqftElement ? sqftElement.textContent.replace(/[^0-9,]/g, '').trim() : '';

                    // Extract bedrooms
                    const bedsElement = listing.querySelector('[class*="bed"], [class*="bedroom"]');
                    const beds = bedsElement ? parseInt(bedsElement.textContent.match(/\d+/)?.[0] || '0') : 0;

                    // Extract bathrooms
                    const bathsElement = listing.querySelector('[class*="bath"], [class*="bathroom"]');
                    const baths = bathsElement ? parseFloat(bathsElement.textContent.match(/[\d.]+/)?.[0] || '0') : 0;

                    // Extract images
                    const imageElements = listing.querySelectorAll('img[src], img[data-src]');
                    const images = Array.from(imageElements)
                        .map(img => img.src || img.dataset.src)
                        .filter(src => src && !src.includes('placeholder'))
                        .slice(0, 5); // Limit to 5 images per listing

                    // Extract listing URL
                    const linkElement = listing.querySelector('a[href*="listing"], a[href*="property"]') || listing.querySelector('a');
                    const listingUrl = linkElement ? linkElement.href : '';

                    // Only add if we have meaningful data
                    if (title && (price || sqft || beds)) {
                        results.push({
                            title,
                            price,
                            sqft,
                            beds,
                            baths,
                            images,
                            listingUrl,
                            agent: 'Brandon Hooley',
                            timestamp: new Date().toISOString()
                        });
                    }
                } catch (error) {
                    console.error('Error extracting listing:', error);
                }
            });

            return results;
        });

        log.info(`Extracted ${listings.length} listings`);

        // Store results in dataset
        if (listings.length > 0) {
            await Actor.pushData(listings);
            log.info('Successfully stored listings in dataset');
        } else {
            log.warning('No listings found - page structure may have changed');
            
            // Take screenshot for debugging
            const screenshot = await page.screenshot({ fullPage: true });
            await Actor.setValue('debug-screenshot', screenshot, { contentType: 'image/png' });
            log.info('Saved debug screenshot to key-value store');
        }

    } catch (error) {
        log.error('Error during scraping:', error);
        throw error;
    } finally {
        await browser.close();
    }
});

/**
 * Click element with retry logic
 * @param {Page} page - Playwright page object
 * @param {string} selector - Element selector
 * @param {number} maxRetries - Maximum retry attempts
 * @param {string} elementName - Name for logging
 * @returns {Promise<boolean>} - Success status
 */
async function clickWithRetry(page, selector, maxRetries, elementName) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const element = await page.$(selector);
            if (element) {
                const isVisible = await element.isVisible();
                if (isVisible) {
                    await element.click();
                    log.info(`Successfully clicked ${elementName}`);
                    await page.waitForTimeout(2000);
                    return true;
                }
            }
            
            if (i < maxRetries - 1) {
                log.info(`Retrying to find ${elementName} (attempt ${i + 2}/${maxRetries})`);
                await page.waitForTimeout(2000);
            }
        } catch (error) {
            log.warning(`Error clicking ${elementName}:`, error.message);
        }
    }
    return false;
}

/**
 * Get random user agent for anti-detection
 * @returns {string} - Random user agent string
 */
function getRandomUserAgent() {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}