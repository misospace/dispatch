import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchIssue as fetchIssueFromGitHub } from "@/lib/github";
import { getSyncRepos } from "@/lib/config";
import { refreshSingleIssue } from "@/lib/issue-sync";
import { isAuthorizedAgentToken } from "@/lib/dispatch-env";

export async function POST(request: NextRequest) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!isAuthorizedAgentToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { repoFullName, issueNumber } = body as {
      repoFullName?: string;
      issueNumber?: number;
    };

    if (!repoFullName || !issueNumber || !Number.isInteger(issueNumber) || issueNumber <= 0) {
      return NextResponse.json(
        { error: "Missing or invalid required fields: repoFullName (string) and issueNumber (integer)" },
        { status: 400 },
      );
    }

    const repos = await getSyncRepos();
    const targetRepo = repos.find((r) => r.fullName === repoFullName);

    if (!targetRepo) {
      return NextResponse.json(
        { error: `Repo ${repoFullName} is not tracked. Track it first via /api/repos or the UI.` },
        { status: 404 },
      );
    }

    const refreshResult = await refreshSingleIssue(repoFullName, issueNumber, fetchIssueFromGitHub);

    if (!refreshResult.success) {
      return NextResponse.json(
        { error: refreshResult.error, repo: refreshResult.repo, issueNumber: refreshResult.issueNumber },
        { status: 502 },
      );
    }

    const issueData = refreshResult.issueData!;

    const existingIssue = await prisma.issue.findUnique({
      where: { repositoryId_number: { repositoryId: targetRepo.id, number: issueData.number } },
    });

    if (existingIssue) {
      await prisma.issue.update({
        where: { id: existingIssue.id },
        data: {
          title: issueData.title,
          body: issueData.body,
          url: issueData.url,
          labels: issueData.labels,
          assignees: issueData.assignees,
          commentsCount: issueData.commentsCount,
          updatedAt: issueData.updatedAt,
          closedAt: issueData.closedAt,
          state: issueData.state,
          lastSyncedAt: issueData.lastSyncedAt,
        },
      });
      return NextResponse.json({
        success: true,
        repo: refreshResult.repo,
        issueNumber: refreshResult.issueNumber,
        action: "updated",
        error: null,
      });
    }

    await prisma.issue.create({
      data: {
        repositoryId: targetRepo.id,
        ...issueData,
      },
    });

    return NextResponse.json({
      success: true,
      repo: refreshResult.repo,
      issueNumber: refreshResult.issueNumber,
      action: "created",
      error: null,
    });
  } catch (error) {
    console.error("Issue refresh failed:", error);
    return NextResponse.json({ error: "Issue refresh failed" }, { status: 500 });
  }
}
