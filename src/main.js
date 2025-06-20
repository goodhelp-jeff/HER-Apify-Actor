const { Actor, log } = require('apify');
const { chromium } = require('playwright');

Actor.main(async () => {
    const input = await Actor.getInput() || {};
    const { targetUrl = 'https://www.hershenberggroup.com/team/brandon-hooley' } = input;

    log.info('Starting scraper...');

    const browser = await chromium.launch({ headless: true });
    
    try {
        const context = await browser.newContext({
            viewport: { width: 1920, height: 1080 }
        });
        const page = await context.newPage();
        
        log.info('Navigating to page...');
        await page.goto(targetUrl, { waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);
        
        // Click ALL LISTINGS
        log.info('Looking for ALL LISTINGS...');
        try {
            await page.click('text="ALL LISTINGS"');
            log.info('Clicked ALL LISTINGS');
            await page.waitForTimeout(5000);
        } catch (e) {
            log.warning('Could not click ALL LISTINGS');
        }
        
        // Scroll and click SEE MORE
        let seeMoreCount = 0;
        for (let i = 0; i < 5; i++) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(2000);
            
            try {
                const seeMore = await page.$('button:has-text("SEE MORE LISTINGS")');
                if (seeMore && await seeMore.isVisible()) {
                    await seeMore.click();
                    seeMoreCount++;
                    log.info(`Clicked SEE MORE ${seeMoreCount} times`);
                    await page.waitForTimeout(3000);
                }
            } catch (e) {
                break;
            }
        }
        
        log.info('Extracting data...');
        
        // Simple extraction - just get all text that looks like listings
        const listings = await page.evaluate(() => {
            const results = [];
            
            // Find all elements with prices
            const priceElements = document.querySelectorAll('*');
            const seen = new Set();
            
            priceElements.forEach(el => {
                const text = el.textContent || '';
                if (text.match(/\$[\d,]+/) && !el.querySelector('*')) {
                    // This element directly contains a price
                    const price = text.trim();
                    
                    // Walk up to find container
                    let container = el.parentElement;
                    while (container && !container.querySelector('img')) {
                        container = container.parentElement;
                    }
                    
                    if (container) {
                        const fullText = container.textContent;
                        
                        // Extract address (simple approach)
                        const match = fullText.match(/(\d+\s+[A-Za-z\s]+)(Flower Mound|Bartonville)/);
                        const address = match ? match[1].trim() : 'Unknown';
                        
                        // Skip duplicates
                        const key = address + price;
                        if (seen.has(key)) return;
                        seen.add(key);
                        
                        // Extract numbers
                        const numbers = fullText.match(/\d+/g) || [];
                        
                        results.push({
                            address: address,
                            price: price,
                            beds: numbers[1] || 0,
                            baths: numbers[2] || 0, 
                            sqft: numbers[3] || 'N/A',
                            text: fullText.substring(0, 300)
                        });
                    }
                }
            });
            
            return results;
        });
        
        log.info(`Found ${listings.length} listings`);
        
        // Save results
        await Actor.pushData(listings);
        
        // Also save a screenshot
        const screenshot = await page.screenshot({ fullPage: true });
        await Actor.setValue('final-screenshot', screenshot, { contentType: 'image/png' });
        
    } catch (error) {
        log.error('Error:', error);
        throw error;
    } finally {
        await browser.close();
    }
});