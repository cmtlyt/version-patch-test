import { exec } from '@actions/exec';
import { context, getOctokit } from '@actions/github';
import { readPackageJSON, resolvePackageJSON, writePackageJSON } from 'pkg-types';
import semver, { type ReleaseType } from 'semver';
import core, { logger } from './core';

async function signUser() {
  logger.info('sign action user');
  await exec('git', ['config', '--global', 'user.name', 'GitHub Action']);
  await exec('git', ['config', '--global', 'user.email', 'action@github.com']);
}

const octokit = (() => {
  return getOctokit(core.getInput('token', { required: true }));
})();

async function getCurentPR() {
  if (!context.payload.pull_request) {
    return {} as Awaited<ReturnType<typeof octokit.rest.pulls.get>>['data'];
  }

  const { data: pr } = await octokit.rest.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.payload.pull_request.number,
  });

  return pr;
}

function getReleaseTypeFromLabel(labels: { name: string }[] = [], betaVersion: string, currentVersion: string) {
  const labelNames = labels.map((label) => label.name);
  let tempReleaseType = '' as ReleaseType;
  if (labelNames.includes('major')) {
    tempReleaseType = 'premajor';
  } else if (labelNames.includes('minor')) {
    tempReleaseType = 'preminor';
  } else if (labelNames.includes('patch')) {
    tempReleaseType = 'prepatch';
  }

  if (tempReleaseType && semver.gt(currentVersion, betaVersion)) {
    tempReleaseType = 'prerelease';
  }

  return tempReleaseType;
}

async function run() {
  try {
    const pr = await getCurentPR();

    let targetBranch = context.ref.split('/').pop()!;

    if (targetBranch !== 'alpha' && targetBranch !== 'beta' && targetBranch !== 'main') {
      logger.info(`不支持的分支: ${context.ref}, 从 pr 获取`);
      logger.info(`pr base ref ${pr.head.ref}`);

      targetBranch = pr.head.ref.split('/').pop()!;
      if (targetBranch !== 'alpha' && targetBranch !== 'beta' && targetBranch !== 'main') {
        logger.info(`不支持的分支: ${pr.head.ref}, 从 pr 获取`);
        return;
      }
    }

    logger.info(`目标分支: ${targetBranch}`);

    await signUser();
    const pkgPath = await resolvePackageJSON();

    let needPopStash = true;

    await exec('git', ['stash']).catch(() => {
      needPopStash = false;
    });
    await exec('git', ['fetch', 'origin', 'beta']);
    await exec('git', ['switch', 'beta']);
    const betaPkgInfo = await readPackageJSON(pkgPath);
    logger.info(`beta version ${betaPkgInfo.version}`);
    await exec('git', ['switch', targetBranch]);
    needPopStash && (await exec('git', ['stash', 'pop']));

    // 读取当前版本号
    const pkgInfo = await readPackageJSON(pkgPath);
    const currentVersion = pkgInfo.version!;
    logger.info(`当前版本: ${currentVersion}`);

    const releaseType = getReleaseTypeFromLabel(pr.labels, betaPkgInfo.version!, currentVersion);
    logger.info(`版本升级类型: ${releaseType}`);

    if (!releaseType) {
      logger.warning(`版本升级类型为空, 跳过`);
      return;
    }

    // 计算新版本
    let newVersion: string | null = null;

    if (targetBranch === 'alpha') {
      const lastSemver = semver.parse(currentVersion);
      if (lastSemver && (!lastSemver.prerelease || lastSemver.prerelease[0] !== 'alpha')) {
        logger.info(`上一个版本 (${currentVersion}) 来自 beta 或 main, 需要提升 minor 版本。`);
        newVersion = semver.inc(currentVersion, releaseType, 'alpha');
      } else {
        // 升级 alpha 补丁版本
        newVersion = semver.inc(currentVersion, releaseType, 'alpha');
      }
    } else if (targetBranch === 'beta') {
      // beta 补丁升级
      newVersion = semver.inc(currentVersion, 'prerelease', 'beta');
    } else if (targetBranch === 'main') {
      // 去除 preid, 转为正式版本
      newVersion = semver.inc(currentVersion, 'patch');
    }

    logger.info(`新版本: ${newVersion}`);

    await exec('git', ['switch', targetBranch]);

    // 更新版本文件
    pkgInfo.version = newVersion!;
    await writePackageJSON(pkgPath, pkgInfo);
    logger.info('版本文件已更新');

    // 提交更改
    await exec('git', ['add', '.']);
    await exec('git', ['commit', '-m', `chore: bump version to ${newVersion} for ${targetBranch}`]);
    await exec('git', ['push', 'origin', targetBranch]);

    if (targetBranch === 'beta') {
      await exec('git', ['fetch', 'origin', 'alpha']);
      await exec('git', ['switch', 'alpha']);
      const alphaPkgInfo = await readPackageJSON(pkgPath);
      logger.info(`alpha version ${alphaPkgInfo.version}`);
      logger.info(`beta version ${newVersion}`);
      await exec('git', [
        'merge',
        'beta',
        '--no-edit',
        '--no-ff',
        '-m',
        `chore: sync beta v${newVersion} to alpha [skip ci]`,
      ]).catch(async () => {
        logger.warning('Alpha 合并冲突');
        if (semver.gt(alphaPkgInfo.version!, newVersion!)) {
          logger.info('Alpha 版本号大于 beta 版本号, 忽略版本变更');
          const newAlphaPkgInfo = await readPackageJSON(pkgPath);
          newAlphaPkgInfo.version = alphaPkgInfo.version;
          logger.info(`alpha pkg info: ${JSON.stringify(newAlphaPkgInfo)}`);
          await writePackageJSON(pkgPath, newAlphaPkgInfo);
          await exec('git', ['add', '.']);
          await exec('git', ['commit', '-m', `chore: sync beta v${newVersion} to alpha [skip ci]`]);
        } else {
          logger.error('Alpha 版本号小于 beta 版本号, 无法自动合并, 尝试打开 pr 进行处理');
        }
      });
      await exec('git', ['push', 'origin', 'alpha', '--force-with-lease']).catch(() => {
        logger.info('Alpha 推送失败');
      });
    } else if (targetBranch === 'main') {
      await exec('git', ['fetch', 'origin', 'main']);
      await exec('git', ['fetch', 'origin', 'beta']);
      await exec('git', ['switch', 'beta']);
      await exec('git', [
        'merge',
        'origin/main',
        '--no-edit',
        '--no-ff',
        '-m',
        `chore: sync main v${newVersion} to beta [skip ci]`,
      ]).catch(async () => {
        logger.info('Beta 合并冲突, 强制同步');
        await exec('git', ['reset', '--hard', 'origin/main']);
        await exec('git', ['commit', '--allow-empty', '-m', `chore: force sync from main v${newVersion} [skip ci]`]);
      });
      await exec('git', ['push', 'origin', 'beta', '--force-with-lease']).catch(() => {
        logger.info('Beta 推送失败');
      });
    }

    // 输出新版本
    core.setOutput('next-version', newVersion);
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

run();
