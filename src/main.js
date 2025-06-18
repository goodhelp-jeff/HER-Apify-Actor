const { Actor, log } = require('apify');
const { chromium } = require('playwright');

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
            extraHTTPHeaders: {
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
            }
        });

        // Inject stealth scripts
        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined
            });

            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' 
                    ? Promise.resolve({ state: Notification.permission }) 
                    : originalQuery(parameters)
            );

            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5]
            });

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
            '[role="tab"]:has-text("ALL LISTINGS")'
        ];

        let allListingsClicked = false;
        for (const selector of allListingsSelectors) {
            try {
                log.info(`Trying selector: ${selector}`);
                const element = await page.locator(selector).first();
                const count = await page.locator(selector).count();
                log.info(`Found ${count} elements with selector: ${selector}`);
                
                if (await element.isVisible()) {
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
            log.info('Waiting for listings to load after clicking ALL LISTINGS tab');
            await page.waitForTimeout(5000);
            
            // Check if listings are now visible
            const listingsVisible = await page.evaluate(() => {
                const allElements = document.querySelectorAll('*');
                for (const element of allElements) {
                    const text = element.textContent || '';
                    if (text.includes('$') && text.match(/\$[\d,]+/)) {
                        return true;
                    }
                    if (text.includes('SQFT') || text.includes('BEDS') || text.includes('BATHS')) {
                        return true;
                    }
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
            'button.see-more-listings',
            '[class*="see-more"]',
            'text="SEE MORE LISTINGS"',
            '//button[text()="SEE MORE LISTINGS"]'
        ];

        while (hasMoreListings) {
            let seeMoreFound = false;
            
            for (const selector of seeMoreSelectors) {
                try {
                    const element = await page.locator(selector).first();
                    if (await element.isVisible()) {
                        log.info(`Clicking SEE MORE LISTINGS button (${seeMoreCount + 1})`);
                        
                        const listingCountBefore = await page.evaluate(() => {
                            let count = 0;
                            const allElements = document.querySelectorAll('*');
                            for (const element of allElements) {
                                const text = element.textContent || '';
                                if (text.includes('$') && text.match(/\$[\d,]+/)) {
                                    count++;
                                }
                            }
                            return count;
                        });
                        
                        await element.click({ force: true });
                        seeMoreCount++;
                        seeMoreFound = true;
                        
                        log.info('Waiting for new listings to load...');
                        await page.waitForTimeout(5000);
                        
                        const listingCountAfter = await page.evaluate(() => {
                            let count = 0;
                            const allElements = document.querySelectorAll('*');
                            for (const element of allElements) {
                                const text = element.textContent || '';
                                if (text.includes('$') && text.match(/\$[\d,]+/)) {
                                    count++;
                                }
                            }
                            return count;
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

            if (seeMoreCount >= 50) {
                log.warning('Reached maximum SEE MORE clicks limit');
                break;
            }
        }

        log.info(`Clicked SEE MORE ${seeMoreCount} times, extracting listings`);
        await page.waitForTimeout(2000);

        // Extract all listings data
        const listings = await page.evaluate((pageUrl) => {
            console.log('Starting listing extraction...');
            
            const results = [];
            
            // Look for listing cards - they appear to be in a grid layout
            // Try multiple selectors based on common patterns
            const cardSelectors = [
                '.listing-card',
                '.property-card',
                '[class*="listing"]',
                '[class*="property"]',
                '.grid > div',
                '[class*="grid"] > div'
            ];
            
            let listingElements = [];
            
            // Try each selector to find listing cards
            for (const selector of cardSelectors) {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 2) { // Expect multiple listings
                    console.log(`Found ${elements.length} elements with selector: ${selector}`);
                    
                    // Verify these are listing cards by checking for price
                    const validCards = Array.from(elements).filter(el => {
                        const text = el.textContent || '';
                        return text.includes('

        log.info(`Extracted ${listings.length} listings`);

        if (listings.length > 0) {
            await Actor.pushData(listings);
            log.info('Successfully stored listings in dataset');
        } else {
            log.warning('No listings found - page structure may have changed');
            
            const screenshot = await page.screenshot({ fullPage: true });
            await Actor.setValue('debug-screenshot', screenshot, { contentType: 'image/png' });
            log.info('Saved debug screenshot to key-value store');
            
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

function getRandomUserAgent() {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}) && text.match(/\$[\d,]+/);
                    });
                    
                    if (validCards.length > 0) {
                        listingElements = validCards;
                        console.log(`Using ${validCards.length} valid listing cards`);
                        break;
                    }
                }
            }
            
            // If no cards found with selectors, look for pattern
            if (listingElements.length === 0) {
                console.log('No cards found with selectors, trying pattern matching...');
                
                // Look for divs that contain price and "Listed X Days Ago"
                const allDivs = document.querySelectorAll('div');
                const potentialCards = [];
                
                allDivs.forEach(div => {
                    const text = div.textContent || '';
                    const hasPrice = text.match(/\$[\d,]+/);
                    const hasListedText = text.includes('Listed') && text.includes('Day');
                    const hasImage = div.querySelector('img');
                    
                    if (hasPrice && hasListedText && hasImage) {
                        // Make sure it's not a parent container
                        const priceElements = div.querySelectorAll('*');
                        let priceCount = 0;
                        priceElements.forEach(el => {
                            if (el.textContent && el.textContent.match(/\$[\d,]+/)) {
                                priceCount++;
                            }
                        });
                        
                        // If only one price element, it's likely a single listing
                        if (priceCount === 1) {
                            potentialCards.push(div);
                        }
                    }
                });
                
                // Remove nested cards
                listingElements = potentialCards.filter((card, index) => {
                    for (let i = 0; i < potentialCards.length; i++) {
                        if (i !== index && potentialCards[i].contains(card)) {
                            return false;
                        }
                    }
                    return true;
                });
                
                console.log(`Found ${listingElements.length} listing cards by pattern`);
            }
            
            // Extract data from each listing card
            listingElements.forEach((card, index) => {
                try {
                    console.log(`Processing listing ${index + 1}`);
                    
                    // Extract address - usually the first text that looks like an address
                    let title = '';
                    const textElements = card.querySelectorAll('*');
                    textElements.forEach(el => {
                        const text = (el.textContent || '').trim();
                        // Match address pattern: number + street name
                        if (text.match(/^\d+\s+\w+/) && !text.includes('

        log.info(`Extracted ${listings.length} listings`);

        if (listings.length > 0) {
            await Actor.pushData(listings);
            log.info('Successfully stored listings in dataset');
        } else {
            log.warning('No listings found - page structure may have changed');
            
            const screenshot = await page.screenshot({ fullPage: true });
            await Actor.setValue('debug-screenshot', screenshot, { contentType: 'image/png' });
            log.info('Saved debug screenshot to key-value store');
            
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

function getRandomUserAgent() {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}) && !text.includes('Listed')) {
                            if (!title || text.length > title.length) {
                                title = text;
                            }
                        }
                    });
                    
                    // Extract price
                    let price = '';
                    const pricePattern = /\$[\d,]+/;
                    textElements.forEach(el => {
                        const text = (el.textContent || '').trim();
                        if (text.match(/^\$[\d,]+$/)) {
                            price = text;
                        }
                    });
                    
                    // Extract property details (beds, baths, sqft)
                    // Looking for patterns with icons or numbers
                    let beds = 0;
                    let baths = 0;
                    let sqft = '';
                    
                    // Look for elements with property details
                    const detailElements = card.querySelectorAll('*');
                    detailElements.forEach(el => {
                        const text = (el.textContent || '').trim();
                        
                        // Try to find beds (look for patterns like "3" near bed icon)
                        if (text.match(/^\d+$/) && parseInt(text) <= 10) {
                            const parent = el.parentElement;
                            if (parent) {
                                const siblingText = parent.textContent || '';
                                // Check if this number is near other property numbers
                                if (siblingText.match(/\d+.*\d+.*[\d,]+/)) {
                                    // This is likely beds or baths
                                    const num = parseInt(text);
                                    if (beds === 0) beds = num;
                                    else if (baths === 0) baths = num;
                                }
                            }
                        }
                        
                        // Look for square footage (larger numbers, often with commas)
                        if (text.match(/^[\d,]+$/) && text.length >= 3) {
                            const num = parseInt(text.replace(/,/g, ''));
                            if (num > 100 && num < 10000) {
                                sqft = text;
                            }
                        }
                    });
                    
                    // Extract image
                    const images = [];
                    const img = card.querySelector('img');
                    if (img && img.src) {
                        images.push(img.src);
                    }
                    
                    // Extract listing URL
                    let listingUrl = '';
                    const link = card.querySelector('a[href]');
                    if (link) {
                        listingUrl = link.href;
                        if (listingUrl.startsWith('/')) {
                            listingUrl = window.location.origin + listingUrl;
                        }
                    }
                    
                    console.log(`Found: ${title} - ${price} - ${beds}bd/${baths}ba - ${sqft}sqft`);
                    
                    if (title && price) {
                        results.push({
                            title,
                            price,
                            sqft: sqft || 'N/A',
                            beds,
                            baths,
                            images,
                            listingUrl: listingUrl || pageUrl,
                            agent: 'Brandon Hooley',
                            timestamp: new Date().toISOString()
                        });
                    }
                } catch (error) {
                    console.error(`Error processing listing ${index + 1}:`, error);
                }
            });
            
            console.log(`Extracted ${results.length} listings total`);
            return results;
        }, targetUrl);

        log.info(`Extracted ${listings.length} listings`);

        if (listings.length > 0) {
            await Actor.pushData(listings);
            log.info('Successfully stored listings in dataset');
        } else {
            log.warning('No listings found - page structure may have changed');
            
            const screenshot = await page.screenshot({ fullPage: true });
            await Actor.setValue('debug-screenshot', screenshot, { contentType: 'image/png' });
            log.info('Saved debug screenshot to key-value store');
            
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