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
            'button:text-is("SEE MORE LISTINGS")',
            'text="SEE MORE LISTINGS"',
            ':has-text("SEE MORE LISTINGS")'
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
        const listings = await page.evaluate(() => {
            console.log('Starting listing extraction...');
            
            const listingSelectors = [
                '.listing-item',
                '.property-item',
                '.property-card',
                '[class*="listing"]',
                '[class*="property"]',
                '.grid > div',
                '[class*="grid"] > div',
                '.card',
                '[class*="card"]',
                'div:has(img)',
                'article:has(img)',
                'section:has(img)'
            ];
            
            let listingElements = [];
            for (const selector of listingSelectors) {
                try {
                    const elements = document.querySelectorAll(selector);
                    console.log(`Selector ${selector} found ${elements.length} elements`);
                    if (elements.length > 0) {
                        listingElements = elements;
                        console.log(`Using selector ${selector} with ${elements.length} listings`);
                        break;
                    }
                } catch (e) {
                    console.log(`Selector ${selector} failed:`, e);
                }
            }
            
            if (listingElements.length === 0) {
                console.log('No listing elements found with specific selectors, trying general approach...');
                
                const allElements = document.querySelectorAll('div, article, section');
                const potentialListings = [];
                
                allElements.forEach(element => {
                    const text = element.textContent || '';
                    if (text.includes('$') && 
                        (text.includes('SQFT') || text.includes('BEDS') || text.includes('BATHS')) &&
                        text.match(/\d+\s+\w+/)) {
                        
                        const hasChildListing = Array.from(element.querySelectorAll('*')).some(child => {
                            const childText = child.textContent || '';
                            return childText.includes('$') && childText.includes('SQFT');
                        });
                        
                        if (!hasChildListing) {
                            potentialListings.push(element);
                        }
                    }
                });
                
                listingElements = potentialListings;
                console.log(`Found ${listingElements.length} potential listings using general approach`);
            }
            
            const results = [];
            
            listingElements.forEach((listing) => {
                try {
                    let title = '';
                    const titleSelectors = ['h3', 'h4', '[class*="address"]', '[class*="title"]', '[class*="street"]', 'a'];
                    
                    for (const selector of titleSelectors) {
                        const element = listing.querySelector(selector);
                        if (element && element.textContent) {
                            const text = element.textContent.trim();
                            if (text.match(/^\d+\s+\w+/) || text.length > 5) {
                                title = text;
                                break;
                            }
                        }
                    }

                    let price = '';
                    const priceElements = listing.querySelectorAll('*');
                    for (const el of priceElements) {
                        const text = el.textContent || '';
                        if (text.includes('$') && text.match(/\$[\d,]+/)) {
                            price = text.match(/\$[\d,]+/)[0];
                            break;
                        }
                    }

                    let sqft = '';
                    const sqftElement = Array.from(listing.querySelectorAll('*')).find(el => 
                        el.textContent && el.textContent.includes('SQFT')
                    );
                    if (sqftElement) {
                        const match = sqftElement.textContent.match(/([\d,]+)\s*SQFT/i);
                        if (match) sqft = match[1];
                    }

                    let beds = 0;
                    const bedsElement = Array.from(listing.querySelectorAll('*')).find(el => 
                        el.textContent && el.textContent.includes('BEDS')
                    );
                    if (bedsElement) {
                        const match = bedsElement.textContent.match(/(\d+)\s*BEDS/i);
                        if (match) beds = parseInt(match[1]);
                    }

                    let baths = 0;
                    const bathsElement = Array.from(listing.querySelectorAll('*')).find(el => 
                        el.textContent && el.textContent.includes('BATHS')
                    );
                    if (bathsElement) {
                        const match = bathsElement.textContent.match(/([\d.]+)\s*BATHS/i);
                        if (match) baths = parseFloat(match[1]);
                    }

                    const imageElements = listing.querySelectorAll('img[src], img[data-src], img[data-lazy-src]');
                    const images = Array.from(imageElements)
                        .map(img => img.src || img.dataset.src || img.dataset.lazySrc)
                        .filter(src => src && !src.includes('placeholder') && !src.includes('logo'))
                        .slice(0, 5);

                    const linkElement = listing.querySelector('a[href]');
                    let listingUrl = '';
                    if (linkElement) {
                        listingUrl = linkElement.href;
                        if (listingUrl.startsWith('/')) {
                            listingUrl = window.location.origin + listingUrl;
                        }
                    }

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