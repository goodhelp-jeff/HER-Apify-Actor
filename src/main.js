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
        
        // Take a screenshot before clicking for debugging
        log.info('Page loaded, looking for ALL LISTINGS tab');

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

        // Try multiple selectors for ALL LISTINGS button/tab
        const allListingsSelectors = [
            'text="ALL LISTINGS"',
            'text=ALL LISTINGS',
            ':has-text("ALL LISTINGS")',
            'a:has-text("ALL LISTINGS")',
            'div:has-text("ALL LISTINGS")',
            '[class*="tab"]:has-text("ALL LISTINGS")',
            '[role="tab"]:has-text("ALL LISTINGS")',
            '//\*[contains(text(), "ALL LISTINGS")]',
            '//a[contains(text(), "ALL LISTINGS")]',
            '//div[contains(text(), "ALL LISTINGS")]'
        ];

        let allListingsClicked = false;
        for (const selector of allListingsSelectors) {
            try {
                log.info(`Trying selector: ${selector}`);
                const element = await page.locator(selector).first();
                const count = await page.locator(selector).count();
                log.info(`Found ${count} elements with selector: ${selector}`);
                
                if (await element.isVisible()) {
                    // Force click even if intercepted
                    await element.click({ force: true });
                    log.info('Successfully clicked ALL LISTINGS tab');
                    allListingsClicked = true;
                    await page.waitForTimeout(3000);
                    break;
                }
            } catch (e) {
                log.info(`Selector ${selector} failed: ${e.message}`);
            }
        }

        if (!allListingsClicked) {
            log.warning('Could not find ALL LISTINGS button, proceeding with available content');
        } else {
            // Wait for listings to appear after clicking ALL LISTINGS
            log.info('Waiting for listings to load after clicking ALL LISTINGS tab');
            await page.waitForTimeout(5000); // Give more time for initial load
            
            // Check if listings are now visible
            const listingsVisible = await page.evaluate(() => {
                const possibleSelectors = [
                    ':has-text("$")',
                    '[class*="price"]',
                    ':has-text("SQFT")',
                    ':has-text("BEDS")'
                ];
                
                for (const selector of possibleSelectors) {
                    const elements = document.querySelectorAll(selector);
                    if (elements.length > 0) return true;
                }
                return false;
            });
            
            if (listingsVisible) {
                log.info('Listings are now visible');
            } else {
                log.warning('No listings visible after clicking ALL LISTINGS');
            }
        }

        // Scroll to bottom
        log.info('Scrolling to bottom of page');
        await smoothScroll('bottom');
        await page.waitForTimeout(2000);

        // Click "SEE MORE" repeatedly until all listings are loaded
        let seeMoreCount = 0;
        let hasMoreListings = true;
        
        const seeMoreSelectors = [
            'button:has-text("SEE MORE LISTINGS")',
            'a:has-text("SEE MORE LISTINGS")',
            'button:text-is("SEE MORE LISTINGS")',
            'text="SEE MORE LISTINGS"',
            ':has-text("SEE MORE LISTINGS")',
            '//button[contains(text(), "SEE MORE LISTINGS")]',
            // The button in the screenshot appears to be styled
            'button.see-more',
            '[class*="see-more"]',
            '[class*="load-more"]'
        ];

        while (hasMoreListings) {
            let seeMoreFound = false;
            
            for (const selector of seeMoreSelectors) {
                try {
                    const element = await page.locator(selector).first();
                    if (await element.isVisible()) {
                        log.info(`Clicking SEE MORE LISTINGS button (${seeMoreCount + 1})`);
                        
                        // Store current listing count before clicking
                        const listingCountBefore = await page.evaluate(() => {
                            return document.querySelectorAll('[class*="price"], :has-text("$")').length;
                        });
                        
                        await element.click({ force: true });
                        seeMoreCount++;
                        seeMoreFound = true;
                        
                        // Wait for new listings to load
                        log.info('Waiting for new listings to load...');
                        await page.waitForTimeout(5000); // Longer wait for dynamic content
                        
                        // Check if new listings were added
                        const listingCountAfter = await page.evaluate(() => {
                            return document.querySelectorAll('[class*="price"], :has-text("$")').length;
                        });
                        
                        log.info(`Listings before: ${listingCountBefore}, after: ${listingCountAfter}`);
                        
                        await smoothScroll('bottom');
                        break;
                    }
                } catch (e) {
                    log.info(`Selector ${selector} failed: ${e.message}`);
                }
            }
            
            if (!seeMoreFound) {
                hasMoreListings = false;
                log.info('No more SEE MORE LISTINGS button found or visible');
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

        // Extract all listings data with more detailed logging
        const listings = await page.evaluate(() => {
            console.log('Starting listing extraction...');
            
            // Multiple possible selectors for listing containers - based on the screenshot
            const listingSelectors = [
                '.listing-item',
                '.property-item',
                '.property-card',
                '[class*="listing"]',
                '[class*="property"]',
                // Looking at the structure, listings appear to be in a grid
                '.grid > div',
                '[class*="grid"] > div',
                // Common card patterns
                '.card',
                '[class*="card"]',
                // Look for elements containing price
                ':has(.price)',
                ':has([class*="price"])',
                // Look for containers with both image and text
                'div:has(img):has(h3)',
                'div:has(img):has([class*="price"])'
            ];
            
            let listingElements = [];
            for (const selector of listingSelectors) {
                const elements = document.querySelectorAll(selector);
                console.log(`Selector ${selector} found ${elements.length} elements`);
                if (elements.length > 0) {
                    listingElements = elements;
                    console.log(`Using selector ${selector} with ${elements.length} listings`);
                    break;
                }
            }
            
            // If no specific listing elements found, try a more general approach
            if (listingElements.length === 0) {
                console.log('No listing elements found with specific selectors, trying general approach...');
                
                // Look for containers that have price AND address-like text
                const allElements = document.querySelectorAll('div, article, section');
                const potentialListings = [];
                
                allElements.forEach(element => {
                    const text = element.textContent;
                    // Check if element contains listing-like content
                    if (text.includes('$') &&
            
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
                    // Extract title/address - based on the screenshot structure
                    let title = '';
                    const titleSelectors = [
                        'h3',
                        'h4',
                        '[class*="address"]',
                        '[class*="title"]',
                        '[class*="street"]',
                        'a[href*="property"]',
                        'a[href*="listing"]'
                    ];
                    
                    for (const selector of titleSelectors) {
                        const element = listing.querySelector(selector);
                        if (element && element.textContent.trim()) {
                            // Check if it contains an address pattern (numbers + text)
                            const text = element.textContent.trim();
                            if (text.match(/^\d+\s+\w+/) || text.length > 5) {
                                title = text;
                                break;
                            }
                        }
                    }

                    // Extract price - clearly visible in the screenshot
                    let price = '';
                    const priceSelectors = [
                        ':has-text("$")',
                        '[class*="price"]',
                        'div:has-text("$")',
                        'span:has-text("$")',
                        'p:has-text("$")'
                    ];
                    
                    for (const selector of priceSelectors) {
                        try {
                            const elements = listing.querySelectorAll('*');
                            for (const el of elements) {
                                if (el.textContent.includes('

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
}) && el.textContent.match(/\$[\d,]+/)) {
                                    price = el.textContent.trim();
                                    break;
                                }
                            }
                            if (price) break;
                        } catch (e) {}
                    }

                    // Extract square footage - visible as "SQFT" in the screenshot
                    let sqft = '';
                    const sqftElement = listing.querySelector(':has-text("SQFT")');
                    if (sqftElement) {
                        const match = sqftElement.textContent.match(/([\d,]+)\s*SQFT/i);
                        if (match) sqft = match[1];
                    }

                    // Extract bedrooms - visible as "BEDS" in the screenshot
                    let beds = 0;
                    const bedsElement = listing.querySelector(':has-text("BEDS")');
                    if (bedsElement) {
                        const match = bedsElement.textContent.match(/(\d+)\s*BEDS/i);
                        if (match) beds = parseInt(match[1]);
                    }

                    // Extract bathrooms - visible as "BATHS" in the screenshot
                    let baths = 0;
                    const bathsElement = listing.querySelector(':has-text("BATHS")');
                    if (bathsElement) {
                        const match = bathsElement.textContent.match(/([\d.]+)\s*BATHS/i);
                        if (match) baths = parseFloat(match[1]);
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
}) && 
                        (text.includes('SQFT') || text.includes('BEDS') || text.includes('BATHS')) &&
                        text.match(/\d+\s+\w+/)) { // Address pattern
                        
                        // Check if this isn't a parent of another listing
                        const hasChildListing = Array.from(element.querySelectorAll('*')).some(child => {
                            const childText = child.textContent;
                            return childText.includes('
            
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
                    // Extract title/address - based on the screenshot structure
                    let title = '';
                    const titleSelectors = [
                        'h3',
                        'h4',
                        '[class*="address"]',
                        '[class*="title"]',
                        '[class*="street"]',
                        'a[href*="property"]',
                        'a[href*="listing"]'
                    ];
                    
                    for (const selector of titleSelectors) {
                        const element = listing.querySelector(selector);
                        if (element && element.textContent.trim()) {
                            // Check if it contains an address pattern (numbers + text)
                            const text = element.textContent.trim();
                            if (text.match(/^\d+\s+\w+/) || text.length > 5) {
                                title = text;
                                break;
                            }
                        }
                    }

                    // Extract price - clearly visible in the screenshot
                    let price = '';
                    const priceSelectors = [
                        ':has-text("$")',
                        '[class*="price"]',
                        'div:has-text("$")',
                        'span:has-text("$")',
                        'p:has-text("$")'
                    ];
                    
                    for (const selector of priceSelectors) {
                        try {
                            const elements = listing.querySelectorAll('*');
                            for (const el of elements) {
                                if (el.textContent.includes('

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
}) && el.textContent.match(/\$[\d,]+/)) {
                                    price = el.textContent.trim();
                                    break;
                                }
                            }
                            if (price) break;
                        } catch (e) {}
                    }

                    // Extract square footage - visible as "SQFT" in the screenshot
                    let sqft = '';
                    const sqftElement = listing.querySelector(':has-text("SQFT")');
                    if (sqftElement) {
                        const match = sqftElement.textContent.match(/([\d,]+)\s*SQFT/i);
                        if (match) sqft = match[1];
                    }

                    // Extract bedrooms - visible as "BEDS" in the screenshot
                    let beds = 0;
                    const bedsElement = listing.querySelector(':has-text("BEDS")');
                    if (bedsElement) {
                        const match = bedsElement.textContent.match(/(\d+)\s*BEDS/i);
                        if (match) beds = parseInt(match[1]);
                    }

                    // Extract bathrooms - visible as "BATHS" in the screenshot
                    let baths = 0;
                    const bathsElement = listing.querySelector(':has-text("BATHS")');
                    if (bathsElement) {
                        const match = bathsElement.textContent.match(/([\d.]+)\s*BATHS/i);
                        if (match) baths = parseFloat(match[1]);
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
}) && childText.includes('SQFT');
                        });
                        
                        if (!hasChildListing) {
                            potentialListings.push(element);
                        }
                    }
                });
                
                listingElements = potentialListings;
                console.log(`Found ${listingElements.length} potential listings using general approach`);
            }
            
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
                    // Extract title/address - based on the screenshot structure
                    let title = '';
                    const titleSelectors = [
                        'h3',
                        'h4',
                        '[class*="address"]',
                        '[class*="title"]',
                        '[class*="street"]',
                        'a[href*="property"]',
                        'a[href*="listing"]'
                    ];
                    
                    for (const selector of titleSelectors) {
                        const element = listing.querySelector(selector);
                        if (element && element.textContent.trim()) {
                            // Check if it contains an address pattern (numbers + text)
                            const text = element.textContent.trim();
                            if (text.match(/^\d+\s+\w+/) || text.length > 5) {
                                title = text;
                                break;
                            }
                        }
                    }

                    // Extract price - clearly visible in the screenshot
                    let price = '';
                    const priceSelectors = [
                        ':has-text("$")',
                        '[class*="price"]',
                        'div:has-text("$")',
                        'span:has-text("$")',
                        'p:has-text("$")'
                    ];
                    
                    for (const selector of priceSelectors) {
                        try {
                            const elements = listing.querySelectorAll('*');
                            for (const el of elements) {
                                if (el.textContent.includes('

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
}) && el.textContent.match(/\$[\d,]+/)) {
                                    price = el.textContent.trim();
                                    break;
                                }
                            }
                            if (price) break;
                        } catch (e) {}
                    }

                    // Extract square footage - visible as "SQFT" in the screenshot
                    let sqft = '';
                    const sqftElement = listing.querySelector(':has-text("SQFT")');
                    if (sqftElement) {
                        const match = sqftElement.textContent.match(/([\d,]+)\s*SQFT/i);
                        if (match) sqft = match[1];
                    }

                    // Extract bedrooms - visible as "BEDS" in the screenshot
                    let beds = 0;
                    const bedsElement = listing.querySelector(':has-text("BEDS")');
                    if (bedsElement) {
                        const match = bedsElement.textContent.match(/(\d+)\s*BEDS/i);
                        if (match) beds = parseInt(match[1]);
                    }

                    // Extract bathrooms - visible as "BATHS" in the screenshot
                    let baths = 0;
                    const bathsElement = listing.querySelector(':has-text("BATHS")');
                    if (bathsElement) {
                        const match = bathsElement.textContent.match(/([\d.]+)\s*BATHS/i);
                        if (match) baths = parseFloat(match[1]);
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