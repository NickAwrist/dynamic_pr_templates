import { Probot, Context} from "probot";
import path from "path";
import fs from "fs";

export default (app: Probot) => {

    app.on(["installation.created", "installation_repositories.added"], async (context: Context) => {
        const payload = context.payload as any;
        let repos: any[] = [];

        if (payload.action === "added" && Array.isArray(payload.repositories_added)) {
            // For installation_repositories.added event
            repos = payload.repositories_added.map((repo: any) => ({
                ...repo,
                owner: { login: payload.installation.account.login }
            }));
        } else if (payload.repositories) {
            // For other events with repositories array
            repos = payload.repositories;
        } else if (payload.repository) {
            // For single repository events
            repos = [payload.repository];
        } else {
            app.log.error("No repositories found");
            return;
        }

        if (repos.length === 0) {
            app.log.error("No repositories found");
            return;
        }

        // Initialize templates for each repository
        for (const repo of repos) {
            await initializeTemplates(context, repo);
        }
    });

    async function initializeTemplates(context: Context, repo: any) {
        const payload = context.payload as any;

        let owner: string;
        let repoName: string;

        if (repo.owner && repo.owner.login) {
            // Standard repository object with owner property
            owner = repo.owner.login;
        } else if (payload.installation && payload.installation.account) {
            // For installation_repositories events
            owner = payload.installation.account.login;
        } else {
            app.log.error("Could not determine repository owner");
            return;
        }

        repoName = repo.name;

        if (!owner || !repoName) {
            app.log.error("Missing owner or repo name");
            return;
        }

        app.log.info(`Initializing templates for ${owner}/${repoName}`);

        try {
            // Get the default branch
            const repoInfo = await context.octokit.repos.get({
                owner,
                repo: repoName
            });

            const defaultBranch = repoInfo.data.default_branch;

            // Create a new branch for template init
            const branchName = "dynamic-pr-templates";

            const refData = await context.octokit.git.getRef({
                owner,
                repo: repoName,
                ref: `heads/${defaultBranch}`
            });

            const sha = refData.data.object.sha;

            // Create a new branch from the default branch
            try{
                await context.octokit.git.createRef({
                    owner,
                    repo: repoName,
                    ref: `refs/heads/${branchName}`,
                    sha
                });
            } catch (error) {
                app.log.info(`Branch ${branchName} already exists or could not be created: ${error}`);
            }

            // Read template files from your init_files directory
            const initFilesPath = path.join(__dirname, "init_files");
            const files = getFilesFromDirectory(initFilesPath);

            // Create commit with template files
            for (const file of files) {
                const relativePath = file.replace(initFilesPath, "");
                const content = fs.readFileSync(file, "utf-8");

                try {
                    // Create or update file in the new branch
                    await context.octokit.repos.createOrUpdateFileContents({
                        owner,
                        repo: repoName,
                        path: `.github${relativePath}`,
                        message: `Add PR template: ${relativePath}`,
                        content: Buffer.from(content).toString("base64"),
                        branch: branchName
                    });

                    app.log.info(`Created template file: .github${relativePath}`);
                } catch (error) {
                    app.log.error(`Error creating template file: ${error}`);
                }
            }

            // Create a pull request to merge the changes
            try {
                await context.octokit.pulls.create({
                    owner,
                    repo: repoName,
                    title: "[SETUP] Add dynamic PR templates",
                    head: branchName,
                    base: defaultBranch,
                    body: "This PR adds dynamic PR templates to your repository. You can customize these templates by editing the files in the `.github/pr_templates` directory."
                });

                app.log.info(`Created PR to merge template files into ${defaultBranch}`);
            } catch (error) {
                app.log.error(`Error creating PR: ${error}`);
            }
        } catch (error) {
            app.log.error(`Error initializing templates for ${owner}/${repoName}: ${error}`);
        }
    }

    // Helper function to get all files in a directory recursively
    function getFilesFromDirectory(dir: string): string[] {
        let results: string[] = [];
        const list = fs.readdirSync(dir);

        list.forEach((file) => {
            const filePath = path.join(dir, file);
            const stat = fs.statSync(filePath);

            if (stat && stat.isDirectory()) {
                results = results.concat(getFilesFromDirectory(filePath));
            } else {
                results.push(filePath);
            }
        });

        return results;
    }

    app.on(["pull_request.opened"], async (context: Context) => {
        if(!("pull_request" in context.payload)) {
            console.log("No pull request found in the context");
            return;
        }
        const {title} = context.payload.pull_request;
        const repo = context.payload.repository;

        // Find prefix between the first two brackets, [PREFIX] TITLE
        const regex = /\[(.*?)]/;
        const match = title.match(regex);
        if (!match) {
            app.log.error("No prefix found in the title");
            return;
        }
        const prefix = match[1].trim();

        // Construct the path to the template file
        const templatePath = ".github/pr_templates/" + prefix + ".md";

        try{
            // Pull the template content from the path
            const templateContent = await context.octokit.repos.getContent({
                owner: repo.owner.login,
                repo: repo.name,
                path: templatePath,
            });

            const content = Buffer.from(
                (templateContent.data as { content: string}).content,
                "base64"
            ).toString("utf-8");

            // Update the PR body with the template content
            await context.octokit.pulls.update({
                owner: repo.owner.login,
                repo: repo.name,
                pull_number: context.payload.pull_request.number,
                body: content,
            });

            app.log.info(`PR body updated with template: ${templatePath}`);
        }catch (error){
            app.log.error(`Error fetching template: ${error}`);
        }
    });
}