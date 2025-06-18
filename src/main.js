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
        const listings = await page.evaluate((pageUrl) => {
            console.log('Starting listing extraction...');
            
            // Based on the screenshot, listings appear to be individual cards
            const results = [];
            
            // First, try to find the container that holds all listings
            const possibleContainers = document.querySelectorAll('.grid, [class*="grid"], [class*="listings"], [class*="properties"]');
            
            let listingElements = [];
            
            // Look for individual listing cards
            possibleContainers.forEach(container => {
                const cards = container.querySelectorAll(':scope > div, :scope > article, :scope > section');
                if (cards.length > 0) {
                    console.log(`Found ${cards.length} potential listing cards in container`);
                    listingElements = cards;
                }
            });
            
            // If no container found, look for cards directly
            if (listingElements.length === 0) {
                const allDivs = document.querySelectorAll('div');
                const potentialListings = [];
                
                allDivs.forEach(div => {
                    const hasImage = div.querySelector('img');
                    const text = div.textContent || '';
                    const hasPrice = text.includes('$') && text.match(/\$[\d,]+/);
                    const hasDetails = text.includes('BATHS') && text.includes('BEDS') && text.includes('SQFT');
                    
                    if (hasImage && hasPrice && hasDetails) {
                        // Make sure this isn't a parent container
                        const childrenWithPrice = div.querySelectorAll(':scope div');
                        let isParent = false;
                        childrenWithPrice.forEach(child => {
                            if (child !== div && child.textContent && child.textContent.includes('$') && child.textContent.includes('SQFT')) {
                                isParent = true;
                            }
                        });
                        
                        if (!isParent) {
                            potentialListings.push(div);
                        }
                    }
                });
                
                // Remove duplicates and nested elements
                listingElements = potentialListings.filter((el, index) => {
                    for (let i = 0; i < potentialListings.length; i++) {
                        if (i !== index && potentialListings[i].contains(el)) {
                            return false;
                        }
                    }
                    return true;
                });
                
                console.log(`Found ${listingElements.length} individual listing cards`);
            }
            
            listingElements.forEach((listing, index) => {
                try {
                    console.log(`Processing listing ${index + 1}`);
                    
                    // Extract address/title
                    let title = '';
                    const possibleTitleElements = listing.querySelectorAll('h1, h2, h3, h4, h5, [class*="address"], [class*="title"]');
                    possibleTitleElements.forEach(el => {
                        const text = (el.textContent || '').trim();
                        if (text.match(/^\d+\s+\w+/) && text.length > title.length) {
                            title = text;
                        }
                    });
                    
                    if (!title) {
                        const allTexts = listing.querySelectorAll('*');
                        allTexts.forEach(el => {
                            const text = (el.textContent || '').trim();
                            if (text.match(/^\d+\s+\w+\s+\w+/) && !text.includes('$') && !text.includes('SQFT')) {
                                title = text;
                            }
                        });
                    }
                    
                    // Extract price
                    let price = '';
                    const priceElements = listing.querySelectorAll('*');
                    priceElements.forEach(el => {
                        const text = (el.textContent || '').trim();
                        const priceMatch = text.match(/^\$[\d,]+$/);
                        if (priceMatch) {
                            price = priceMatch[0];
                        }
                    });
                    
                    // Extract BATHS
                    let baths = 0;
                    const bathElements = listing.querySelectorAll('*');
                    bathElements.forEach(el => {
                        const text = (el.textContent || '').trim();
                        if (text === 'BATHS') {
                            const parent = el.parentElement;
                            if (parent) {
                                const parentText = parent.textContent || '';
                                const bathMatch = parentText.match(/(\d+\.?\d*)\s*BATHS/);
                                if (bathMatch) {
                                    baths = parseFloat(bathMatch[1]);
                                }
                            }
                        }
                    });
                    
                    // Extract BEDS
                    let beds = 0;
                    const bedElements = listing.querySelectorAll('*');
                    bedElements.forEach(el => {
                        const text = (el.textContent || '').trim();
                        if (text === 'BEDS') {
                            const parent = el.parentElement;
                            if (parent) {
                                const parentText = parent.textContent || '';
                                const bedMatch = parentText.match(/(\d+)\s*BEDS/);
                                if (bedMatch) {
                                    beds = parseInt(bedMatch[1]);
                                }
                            }
                        }
                    });
                    
                    // Extract SQFT
                    let sqft = '';
                    const sqftElements = listing.querySelectorAll('*');
                    sqftElements.forEach(el => {
                        const text = (el.textContent || '').trim();
                        if (text === 'SQFT') {
                            const parent = el.parentElement;
                            if (parent) {
                                const parentText = parent.textContent || '';
                                const sqftMatch = parentText.match(/([\d,]+)\s*SQFT/);
                                if (sqftMatch) {
                                    sqft = sqftMatch[1];
                                }
                            }
                        }
                    });
                    
                    // Extract images
                    const imageElements = listing.querySelectorAll('img[src], img[data-src], img[data-lazy-src]');
                    const images = Array.from(imageElements)
                        .map(img => {
                            const src = img.src || img.dataset.src || img.dataset.lazySrc || '';
                            if (src.startsWith('http')) {
                                return src;
                            } else if (src.startsWith('/')) {
                                return window.location.origin + src;
                            }
                            return src;
                        })
                        .filter(src => src && !src.includes('placeholder') && !src.includes('logo'))
                        .slice(0, 1);
                    
                    // Extract listing URL
                    let listingUrl = '';
                    const linkElement = listing.querySelector('a[href]');
                    if (linkElement) {
                        listingUrl = linkElement.href;
                        if (listingUrl.startsWith('/')) {
                            listingUrl = window.location.origin + listingUrl;
                        }
                    }
                    
                    console.log(`Listing ${index + 1}: ${title} - ${price} - ${beds} beds, ${baths} baths, ${sqft} sqft`);
                    
                    // Only add if we have meaningful data
                    if (title && (price || sqft || beds)) {
                        results.push({
                            title,
                            price: price || 'Contact for price',
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
                    console.error('Error extracting listing:', error);
                }
            });
            
            console.log(`Successfully extracted ${results.length} unique listings`);
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