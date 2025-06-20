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
            const seen = new Set();
            
            // Find all elements that contain ONLY a price (no children with prices)
            const priceElements = [];
            document.querySelectorAll('*').forEach(el => {
                const text = el.textContent || '';
                const hasPrice = text.match(/^\$[\d,]+$/);
                const hasChildWithPrice = el.querySelector('*') && Array.from(el.querySelectorAll('*')).some(
                    child => child.textContent && child.textContent.match(/^\$[\d,]+$/)
                );
                
                if (hasPrice && !hasChildWithPrice) {
                    priceElements.push(el);
                }
            });
            
            priceElements.forEach(priceEl => {
                const price = priceEl.textContent.trim();
                
                // Walk up to find the listing container
                let container = priceEl.parentElement;
                let depth = 0;
                while (container && depth < 10) {
                    // Stop if we find an image (likely the listing card)
                    if (container.querySelector('img')) {
                        break;
                    }
                    container = container.parentElement;
                    depth++;
                }
                
                if (!container) return;
                
                const fullText = container.textContent;
                
                // Extract address more carefully
                let address = 'Unknown';
                const addressPatterns = [
                    /(\d+\s+[A-Za-z\s]+(?:Drive|Lane|Court|Road|Way|Boulevard|Parkway|Circle|Place))/i,
                    /(\d+\s+[A-Za-z\s]+)(?=Flower Mound|Bartonville)/
                ];
                
                for (const pattern of addressPatterns) {
                    const match = fullText.match(pattern);
                    if (match) {
                        address = match[1].trim();
                        break;
                    }
                }
                
                // Skip if we've seen this listing
                const key = address + price;
                if (seen.has(key)) return;
                seen.add(key);
                
                // Extract beds/baths/sqft more carefully
                let beds = 0, baths = 0, sqft = 'N/A';
                
                // Look for patterns like "3 Beds" or "Beds: 3"
                const bedsMatch = fullText.match(/(\d+)\s*Bed|Bed[s]?\s*[:=]?\s*(\d+)/i);
                if (bedsMatch) beds = parseInt(bedsMatch[1] || bedsMatch[2]) || 0;
                
                // Look for patterns like "2.5 Baths" or "Baths: 2.5"
                const bathsMatch = fullText.match(/([\d.]+)\s*Bath|Bath[s]?\s*[:=]?\s*([\d.]+)/i);
                if (bathsMatch) baths = parseFloat(bathsMatch[1] || bathsMatch[2]) || 0;
                
                // Look for patterns like "2,500 Sqft" or "Sqft: 2,500"
                const sqftMatch = fullText.match(/([\d,]+)\s*(?:Sqft|Sq\s*Ft)|(?:Sqft|Sq\s*Ft)\s*[:=]?\s*([\d,]+)/i);
                if (sqftMatch) sqft = (sqftMatch[1] || sqftMatch[2] || '').replace(/,/g, '');
                
                // Only add if we have a valid address
                if (address !== 'Unknown' && !address.includes('function')) {
                    results.push({
                        address: address,
                        price: price,
                        beds: beds,
                        baths: baths,
                        sqft: sqft
                    });
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