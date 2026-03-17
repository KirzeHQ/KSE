# Contributing

## Options

- Hosting a scraper on your own server and submitting scrapes to the API
- Contributing to the codebase (API, scraper, frontend)
- Suggesting new features or improvements

## Scraper Contributions

Coming soon but a quick overview on how it will work:  
You call the api using the scraper script,  
The api assigns you with an ID and API key,
You run the scraper with the assigned ID and API key,
Scrapers are automatically assigned a website to scrape based on a queue system,  
Your scraper will submit scrapes to the API and once 3 versions of a website
have been recorded from 3 independent scrapers. The API will store the data  
As your scraper gains trust and reliability, less scrapes will be required from other scrapers to store the data.  
Eventually you can submit your scraper to review and if it is deemed reliable
then you will be added to a list of trusted scrapers and your scrapes will be stored immediately
without needing to wait for other scrapers to submit the same data.

## Code Contributions

1. Fork the repository
2. Do your code changes
3. Submit a PR with a clear description
4. PR will be reviewed and merged

## Feature Suggestions

1. Open an issue with a clear description of the feature and its benefits
2. The community and maintainers will discuss the feature and its implementation
3. If the feature is accepted, it may be added to the roadmap and implemented by contributors