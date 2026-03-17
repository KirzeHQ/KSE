# Kirze Search Engine (KSE)

## Overview

KSE is a modular, API-first search engine designed to scrape, store, and query data from multiple online sources (the whole internet). It uses a hybrid storage approach to provide fast access to recent data while maintaining long-term archival of historical scrapes.

## Goals

- Provide a robust search API capable of efficiently querying multiple sources at a time.
- Implement an easy-to-use scraper system where each scraper run identifies itself with a unique ID.
- Maintain a hybrid storage system for both hot and cold data.
- Ensure scalability and modularity for adding new scrapers and sources.
- Utilize free or minimal-cost hosting and storage where possible.

## Architecture

- **Universal Scraper**: A flexible scraper that handles all scraping tasks and identifies itself with a unique scraper ID.
- **API**: A serverless API responsible for receiving scraper submissions and serving search queries.
- **Hot Storage**: Store the latest scrapes (last 3 per website) for fast access.
- **Cold Storage**: Stores historical scrapes organized by date in Github private repositories for long-term access.
- **Search Engine**: A search engine that queries both hot and cold storage to provide comprehensive search results.
- **Frontend**: Static website hosted on Github Pages using the API.

## Stack

- **Scraper**: JavaScript
- **API**: Rust
- **Data storage**:
  - S3-compatible storage (for hot scrapes)
  - Github private repos (for cold scrapes)
- **Hosting**:
  - API: Vercel
  - Frontend: Github Pages
  - Scrapers: Community-run (and my personal server)
- **Automation**: Github Actions for automated scraper commits to cold storage
- **Data Format**: Binary (`.bin`) for efficient storage and retrieval

## Features

- Modular scraper system with self-identifying scrapers
- Hybrid storage for fast-access recent data and long-term archival access
- API-first design for easy integration with various frontends
- Configurable retention policies for hot storage
- Automated archival of outdated/removed sources
- Scalable design to easily add new sources and scraper types

## Usage

- Scraper runs are executed with a unique scraper ID via a config file (INI).
- Scraper serializes data to `.bin` format and submits it via a PATCH request to the API using its API key and ID.
- The API stores the latest three scrapes in hot storage and archives older scrapes to cold storage.
- The frontend queries the API for search results.