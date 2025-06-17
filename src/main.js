const { Actor, log } = require('apify');
const { chromium } = require('playwright');

Actor.main(async () => {
    // Get input configuration
    const input = await Actor.getInput() || {};
    const {
        startUrls = [{ url: 'https://www.hershenberggroup.com/team/brandon-hooley' }],
        maxRetries = 3,
        scrollDelay = 1500,
        useProxy = true,
        proxyConfiguration
    } = input;

    // Extract the URL from the startUrls array
    const targetUrl = startUrls[0]?.url || 'https://www.hershenberggroup.com/team/brandon-hooley';

    log.info('Starting Hershenberg Group listings scraper', { targetUrl });

    // Configure browser launch options
    const launchOptions = {
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process'
        ]
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
            userAgent: getRandomUserAgent(),
            // Additional stealth settings
            locale: 'en-US',
            timezoneId: 'America/New_York',
            permissions: [],
            deviceScaleFactor: 1,
            isMobile: false,
            hasTouch: false,
            colorScheme: 'light',
            reducedMotion: 'no-preference',
            forcedColors: 'none',
            acceptDownloads: false,
            // Extra HTTP headers
            extraHTTPHeaders: {
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
            }
        });

        // Inject stealth scripts
        await context.addInitScript(() => {
            // Override navigator.webdriver
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined
            });

            // Override permissions
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' 
                    ? Promise.resolve({ state: Notification.permission }) 
                    : originalQuery(parameters)
            );

            // Override plugins
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5]
            });

            // Override languages
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en']
            });
        });

        const page = await context.newPage();
        
        // Enable request interception to block unnecessary resources
        await page.route('**/*', (route) => {
            const resourceType = route.request().resourceType();
            if (['font', 'media', 'websocket'].includes(resourceType)) {
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

        // Wait for initial content to load
        await page.waitForTimeout(3000);

        // Natural scrolling function
        const smoothScroll = async (target) => {
            await page.evaluate(async (scrollTarget) => {
                const element = scrollTarget === 'bottom' 
                    ? document.documentElement
                    : scrollTarget === 'middle'
                    ? document.body 
                    : document.querySelector(scrollTarget);
                
                if (element) {
                    const targetY = scrollTarget === 'bottom' 
                        ? document.documentElement.scrollHeight
                        : scrollTarget === 'middle'
                        ? window.innerHeight / 2
                        : element.getBoundingClientRect().top + window.pageYOffset;

                    window.scrollTo({
                        top: targetY,
                        behavior: 'smooth'
                    });
                }
            }, target);
            await page.waitForTimeout(scrollDelay);
        };

        // Scroll to middle of page to load content
        log.info('Scrolling to middle of page');
        await smoothScroll('middle');
        await page.waitForTimeout(2000);

        // Try multiple selectors for ALL LISTINGS button
        const allListingsSelectors = [
            'button:has-text("ALL LISTINGS")',
            'a:has-text("ALL LISTINGS")',
            'button:text-is("ALL LISTINGS")',
            'a:text-is("ALL LISTINGS")',
            '[class*="listing"] button',
            '[class*="all-listings"]',
            'button[aria-label*="listings"]'
        ];

        let allListingsClicked = false;
        for (const selector of allListingsSelectors) {
            try {
                const element = await page.locator(selector).first();
                if (await element.isVisible()) {
                    await element.click();
                    log.info('Successfully clicked ALL LISTINGS button');
                    allListingsClicked = true;
                    await page.waitForTimeout(3000);
                    break;
                }
            } catch (e) {
                // Continue to next selector
            }
        }

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
        
        const seeMoreSelectors = [
            'button:has-text("SEE MORE")',
            'a:has-text("SEE MORE")',
            'button:text-is("SEE MORE")',
            'a:text-is("SEE MORE")',
            'button:has-text("Load More")',
            'a:has-text("Load More")',
            '[class*="see-more"]',
            '[class*="load-more"]'
        ];

        while (hasMoreListings) {
            let seeMoreFound = false;
            
            for (const selector of seeMoreSelectors) {
                try {
                    const element = await page.locator(selector).first();
                    if (await element.isVisible()) {
                        log.info(`Clicking SEE MORE button (${seeMoreCount + 1})`);
                        await element.click();
                        seeMoreCount++;
                        seeMoreFound = true;
                        await page.waitForTimeout(3000);
                        await smoothScroll('bottom');
                        break;
                    }
                } catch (e) {
                    // Continue to next selector
                }
            }
            
            if (!seeMoreFound) {
                hasMoreListings = false;
            }

            // Safety limit to prevent infinite loops
            if (seeMoreCount >= 50) {
                log.warning('Reached maximum SEE MORE clicks limit');
                break;
            }
        }

        log.info(`Clicked SEE MORE ${seeMoreCount} times, extracting listings`);

        // Wait for any final content to load
        await page.waitForTimeout(2000);

        // Extract all listings data
        const listings = await page.evaluate(() => {
            // Multiple possible selectors for listing containers
            const listingSelectors = [
                '[class*="listing"]',
                '[class*="property"]',
                'article',
                '.card',
                '[class*="home"]',
                '[class*="real-estate"]',
                '[data-listing]',
                '[class*="result"]'
            ];
            
            let listingElements = [];
            for (const selector of listingSelectors) {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    listingElements = elements;
                    break;
                }
            }
            
            const results = [];
            
            listingElements.forEach((listing) => {
                try {
                    // Extract title/address with multiple selectors
                    let title = '';
                    const titleSelectors = [
                        '[class*="title"]',
                        '[class*="address"]',
                        'h1', 'h2', 'h3', 'h4',
                        '[class*="name"]',
                        '[class*="street"]'
                    ];
                    
                    for (const selector of titleSelectors) {
                        const element = listing.querySelector(selector);
                        if (element && element.textContent.trim()) {
                            title = element.textContent.trim();
                            break;
                        }
                    }

                    // Extract price with multiple selectors
                    let price = '';
                    const priceSelectors = [
                        '[class*="price"]',
                        '[class*="cost"]',
                        '[data-price]',
                        '[class*="amount"]',
                        ':has-text("$")'
                    ];
                    
                    for (const selector of priceSelectors) {
                        const element = listing.querySelector(selector);
                        if (element && element.textContent.includes('$')) {
                            price = element.textContent.trim();
                            break;
                        }
                    }

                    // Extract square footage
                    let sqft = '';
                    const sqftSelectors = [
                        '[class*="sqft"]',
                        '[class*="square"]',
                        '[class*="area"]',
                        ':has-text("sq ft")',
                        ':has-text("sqft")'
                    ];
                    
                    for (const selector of sqftSelectors) {
                        const element = listing.querySelector(selector);
                        if (element) {
                            const match = element.textContent.match(/[\d,]+/);
                            if (match) {
                                sqft = match[0];
                                break;
                            }
                        }
                    }

                    // Extract bedrooms
                    let beds = 0;
                    const bedSelectors = [
                        '[class*="bed"]',
                        ':has-text("bed")',
                        ':has-text("BR")'
                    ];
                    
                    for (const selector of bedSelectors) {
                        const element = listing.querySelector(selector);
                        if (element) {
                            const match = element.textContent.match(/(\d+)/);
                            if (match) {
                                beds = parseInt(match[1]);
                                break;
                            }
                        }
                    }

                    // Extract bathrooms
                    let baths = 0;
                    const bathSelectors = [
                        '[class*="bath"]',
                        ':has-text("bath")',
                        ':has-text("BA")'
                    ];
                    
                    for (const selector of bathSelectors) {
                        const element = listing.querySelector(selector);
                        if (element) {
                            const match = element.textContent.match(/([\d.]+)/);
                            if (match) {
                                baths = parseFloat(match[1]);
                                break;
                            }
                        }
                    }

                    // Extract images
                    const imageElements = listing.querySelectorAll('img[src], img[data-src], img[data-lazy-src]');
                    const images = Array.from(imageElements)
                        .map(img => img.src || img.dataset.src || img.dataset.lazySrc)
                        .filter(src => src && !src.includes('placeholder') && !src.includes('logo'))
                        .slice(0, 5);

                    // Extract listing URL
                    const linkElement = listing.querySelector('a[href]');
                    let listingUrl = '';
                    if (linkElement) {
                        listingUrl = linkElement.href;
                        // Make URL absolute if needed
                        if (listingUrl.startsWith('/')) {
                            listingUrl = window.location.origin + listingUrl;
                        }
                    }

                    // Only add if we have meaningful data
                    if (title && (price || sqft || beds)) {
                        results.push({
                            title,
                            price: price || 'Contact for price',
                            sqft: sqft || 'N/A',
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
            
            // Also save the page HTML for debugging
            const html = await page.content();
            await Actor.setValue('debug-html', html, { contentType: 'text/html' });
            log.info('Saved page HTML to key-value store');
        }

    } catch (error) {
        log.error('Error during scraping:', error);
        throw error;
    } finally {
        await browser.close();
    }
});

/**
 * Get random user agent for anti-detection
 * @returns {string} - Random user agent string
 */
function getRandomUserAgent() {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}