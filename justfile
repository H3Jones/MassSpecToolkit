_default:
    just --list

run-playground:
    cd packages/ms-toolkit && vp dev playground

# Build and publish from the latest commit on GitHub's default branch.
release:
    gh workflow run release-browser.yml

# Deploy the GitHub Pages site
deploy-pages:
    gh workflow run deploy-pages.yml
    