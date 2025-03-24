import { Probot, Context} from "probot";

export default (app: Probot) => {
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