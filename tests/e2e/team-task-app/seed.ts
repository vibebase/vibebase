#!/usr/bin/env tsx
// Seed Test Data for E2E Tests
// E2Eテスト用のテストデータ投入スクリプト

import { createClient } from '@vibebase/sdk';
import {
  testUsers,
  generateTeams,
  generateTeamMembers,
  generateProjects,
  generateTasks,
  generateTaskComments,
  generateAPIKeys,
  generateActivityLogs
} from './fixtures/seed-data';

const apiUrl = process.env.VIBEBASE_API_URL || 'http://localhost:8787';
const apiKey = process.env.VIBEBASE_API_KEY || 'vb_live_test123456789012345678901234567890';

console.log('🌱 Seeding test data for E2E tests...\n');

// Vibebaseクライアントの初期化
const vibebase = createClient({
  apiUrl,
  apiKey
});

async function seedData() {
  try {
    console.log('📝 Creating test users...');
    const userIds: string[] = [];
    
    for (const userData of testUsers) {
      try {
        // 既存ユーザーがあるかチェック
        const existing = await vibebase.data.list('users', {
          where: { email: userData.email }
        });
        
        console.log(`   🔍 Checking existing user ${userData.email}:`, existing);
        
        if (existing && existing.data && existing.data.length > 0) {
          console.log(`   ℹ️  User ${userData.email} already exists`);
          userIds.push(existing.data[0].id);
        } else {
          const user = await vibebase.data.create('users', userData);
          console.log(`   🔍 Created user response:`, user);
          userIds.push(user.id);
          console.log(`   ✅ Created user: ${userData.email}`);
        }
      } catch (error) {
        console.error(`   ❌ Failed to create user ${userData.email}:`, error);
        console.error(`   📄 Full error:`, JSON.stringify(error, null, 2));
        throw error;
      }
    }

    console.log('\n🏢 Creating test teams...');
    const teams = generateTeams(userIds);
    const teamIds: string[] = [];
    
    for (const teamData of teams) {
      try {
        const team = await vibebase.data.create('teams', teamData);
        teamIds.push(team.id);
        console.log(`   ✅ Created team: ${teamData.name}`);
      } catch (error) {
        console.error(`   ❌ Failed to create team ${teamData.name}:`, error);
        throw error;
      }
    }

    console.log('\n👥 Creating team memberships...');
    const teamMembers = generateTeamMembers(teamIds, userIds);
    
    for (const memberData of teamMembers) {
      try {
        await vibebase.data.create('team_members', memberData);
        console.log(`   ✅ Added member to team`);
      } catch (error) {
        console.error(`   ❌ Failed to create team membership:`, error);
        // チームメンバーシップの失敗は続行可能
      }
    }

    console.log('\n📋 Creating test projects...');
    const projects = generateProjects(teamIds, userIds);
    const projectIds: string[] = [];
    
    for (const projectData of projects) {
      try {
        const project = await vibebase.data.create('projects', projectData);
        projectIds.push(project.id);
        console.log(`   ✅ Created project: ${projectData.name}`);
      } catch (error) {
        console.error(`   ❌ Failed to create project ${projectData.name}:`, error);
        throw error;
      }
    }

    console.log('\n✅ Creating test tasks...');
    const tasks = generateTasks(projectIds, userIds);
    const taskIds: string[] = [];
    
    for (const taskData of tasks) {
      try {
        const task = await vibebase.data.create('tasks', taskData);
        taskIds.push(task.id);
        console.log(`   ✅ Created task: ${taskData.title}`);
      } catch (error) {
        console.error(`   ❌ Failed to create task ${taskData.title}:`, error);
        throw error;
      }
    }

    console.log('\n💬 Creating task comments...');
    const comments = generateTaskComments(taskIds, userIds);
    
    for (const commentData of comments) {
      try {
        await vibebase.data.create('task_comments', commentData);
        console.log(`   ✅ Created comment`);
      } catch (error) {
        console.error(`   ❌ Failed to create comment:`, error);
        // コメントの失敗は続行可能
      }
    }

    console.log('\n🔑 Creating test API keys...');
    const apiKeys = generateAPIKeys(userIds);
    
    for (const apiKeyData of apiKeys) {
      try {
        // 既存のキーをチェック
        const existing = await vibebase.data.list('api_keys', {
          where: { id: apiKeyData.id }
        });
        
        if (existing.data.length === 0) {
          await vibebase.data.create('api_keys', apiKeyData);
          console.log(`   ✅ Created API key: ${apiKeyData.name}`);
        } else {
          console.log(`   ℹ️  API key ${apiKeyData.name} already exists`);
        }
      } catch (error) {
        console.error(`   ❌ Failed to create API key:`, error);
        // API キーの失敗は続行可能
      }
    }

    console.log('\n📊 Creating activity logs...');
    const activities = generateActivityLogs(teamIds, projectIds, taskIds, userIds);
    
    // アクティビティログは一括作成
    try {
      await vibebase.data.bulkInsert('activity_logs', activities);
      console.log(`   ✅ Created ${activities.length} activity logs`);
    } catch (error) {
      console.error(`   ❌ Failed to create activity logs:`, error);
      // アクティビティログの失敗は続行可能
    }

    // テストIDを保存（後でクリーンアップ用）
    const testData = {
      userIds,
      teamIds,
      projectIds,
      taskIds,
      seedDate: new Date().toISOString()
    };

    try {
      await vibebase.storage.upload(
        'test-data/e2e-test-ids.json',
        JSON.stringify(testData, null, 2),
        {
          contentType: 'application/json'
        }
      );
      console.log('\n💾 Saved test data IDs to storage');
    } catch (error) {
      console.log('\n⚠️  Could not save test IDs to storage:', error);
    }

    console.log('\n✨ Seed data creation complete!\n');
    console.log('📊 Summary:');
    console.log(`   Users: ${userIds.length}`);
    console.log(`   Teams: ${teamIds.length}`);
    console.log(`   Projects: ${projectIds.length}`);
    console.log(`   Tasks: ${taskIds.length}`);
    console.log(`   Comments: ${comments.length}`);
    console.log(`   Activities: ${activities.length}`);
    console.log('');
    console.log('🚀 Ready to run E2E tests!');

  } catch (error) {
    console.error('\n❌ Error during seeding:', error);
    throw error;
  }
}


// メイン実行
seedData().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});