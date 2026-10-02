import { assertBenchmarkTaskSpec, type BenchmarkTaskSpec } from '../../benchmark-contract/src/index.ts'

/** 官方仓库固定 revision；资产与 Python 包不打进默认安装。 */
export const OFFICIAL_SOURCE = {
  repository: 'https://github.com/Lifelong-Robot-Learning/LIBERO',
  revision: '8f1084e3132a39270c3a13ebe37270a43ece2a01',
} as const

export const OFFICIAL_SUITES = ['libero_spatial', 'libero_object', 'libero_goal', 'libero_90', 'libero_10'] as const
export type OfficialSuiteId = (typeof OFFICIAL_SUITES)[number]
export const DEFAULT_SUITE: OfficialSuiteId = 'libero_10'

/**
 * 官方 `libero_suite_task_map` 的任务 ID。只含身份，不含动作序列或解题脚本。
 * 语言指令由官方 `grab_language_from_filename` 规则生成。
 */
export const OFFICIAL_TASK_IDS: Record<OfficialSuiteId, readonly string[]> = {
  libero_spatial: [
    'pick_up_the_black_bowl_between_the_plate_and_the_ramekin_and_place_it_on_the_plate',
    'pick_up_the_black_bowl_next_to_the_ramekin_and_place_it_on_the_plate',
    'pick_up_the_black_bowl_from_table_center_and_place_it_on_the_plate',
    'pick_up_the_black_bowl_on_the_cookie_box_and_place_it_on_the_plate',
    'pick_up_the_black_bowl_in_the_top_drawer_of_the_wooden_cabinet_and_place_it_on_the_plate',
    'pick_up_the_black_bowl_on_the_ramekin_and_place_it_on_the_plate',
    'pick_up_the_black_bowl_next_to_the_cookie_box_and_place_it_on_the_plate',
    'pick_up_the_black_bowl_on_the_stove_and_place_it_on_the_plate',
    'pick_up_the_black_bowl_next_to_the_plate_and_place_it_on_the_plate',
    'pick_up_the_black_bowl_on_the_wooden_cabinet_and_place_it_on_the_plate',
  ],
  libero_object: [
    'pick_up_the_alphabet_soup_and_place_it_in_the_basket',
    'pick_up_the_cream_cheese_and_place_it_in_the_basket',
    'pick_up_the_salad_dressing_and_place_it_in_the_basket',
    'pick_up_the_bbq_sauce_and_place_it_in_the_basket',
    'pick_up_the_ketchup_and_place_it_in_the_basket',
    'pick_up_the_tomato_sauce_and_place_it_in_the_basket',
    'pick_up_the_butter_and_place_it_in_the_basket',
    'pick_up_the_milk_and_place_it_in_the_basket',
    'pick_up_the_chocolate_pudding_and_place_it_in_the_basket',
    'pick_up_the_orange_juice_and_place_it_in_the_basket',
  ],
  libero_goal: [
    'open_the_middle_drawer_of_the_cabinet',
    'put_the_bowl_on_the_stove',
    'put_the_wine_bottle_on_top_of_the_cabinet',
    'open_the_top_drawer_and_put_the_bowl_inside',
    'put_the_bowl_on_top_of_the_cabinet',
    'push_the_plate_to_the_front_of_the_stove',
    'put_the_cream_cheese_in_the_bowl',
    'turn_on_the_stove',
    'put_the_bowl_on_the_plate',
    'put_the_wine_bottle_on_the_rack',
  ],
  libero_10: [
    'LIVING_ROOM_SCENE2_put_both_the_alphabet_soup_and_the_tomato_sauce_in_the_basket',
    'LIVING_ROOM_SCENE2_put_both_the_cream_cheese_box_and_the_butter_in_the_basket',
    'KITCHEN_SCENE3_turn_on_the_stove_and_put_the_moka_pot_on_it',
    'KITCHEN_SCENE4_put_the_black_bowl_in_the_bottom_drawer_of_the_cabinet_and_close_it',
    'LIVING_ROOM_SCENE5_put_the_white_mug_on_the_left_plate_and_put_the_yellow_and_white_mug_on_the_right_plate',
    'STUDY_SCENE1_pick_up_the_book_and_place_it_in_the_back_compartment_of_the_caddy',
    'LIVING_ROOM_SCENE6_put_the_white_mug_on_the_plate_and_put_the_chocolate_pudding_to_the_right_of_the_plate',
    'LIVING_ROOM_SCENE1_put_both_the_alphabet_soup_and_the_cream_cheese_box_in_the_basket',
    'KITCHEN_SCENE8_put_both_moka_pots_on_the_stove',
    'KITCHEN_SCENE6_put_the_yellow_and_white_mug_in_the_microwave_and_close_it',
  ],
  libero_90: [
    'KITCHEN_SCENE10_close_the_top_drawer_of_the_cabinet',
    'KITCHEN_SCENE10_close_the_top_drawer_of_the_cabinet_and_put_the_black_bowl_on_top_of_it',
    'KITCHEN_SCENE10_put_the_black_bowl_in_the_top_drawer_of_the_cabinet',
    'KITCHEN_SCENE10_put_the_butter_at_the_back_in_the_top_drawer_of_the_cabinet_and_close_it',
    'KITCHEN_SCENE10_put_the_butter_at_the_front_in_the_top_drawer_of_the_cabinet_and_close_it',
    'KITCHEN_SCENE10_put_the_chocolate_pudding_in_the_top_drawer_of_the_cabinet_and_close_it',
    'KITCHEN_SCENE1_open_the_bottom_drawer_of_the_cabinet',
    'KITCHEN_SCENE1_open_the_top_drawer_of_the_cabinet',
    'KITCHEN_SCENE1_open_the_top_drawer_of_the_cabinet_and_put_the_bowl_in_it',
    'KITCHEN_SCENE1_put_the_black_bowl_on_the_plate',
    'KITCHEN_SCENE1_put_the_black_bowl_on_top_of_the_cabinet',
    'KITCHEN_SCENE2_open_the_top_drawer_of_the_cabinet',
    'KITCHEN_SCENE2_put_the_black_bowl_at_the_back_on_the_plate',
    'KITCHEN_SCENE2_put_the_black_bowl_at_the_front_on_the_plate',
    'KITCHEN_SCENE2_put_the_middle_black_bowl_on_the_plate',
    'KITCHEN_SCENE2_put_the_middle_black_bowl_on_top_of_the_cabinet',
    'KITCHEN_SCENE2_stack_the_black_bowl_at_the_front_on_the_black_bowl_in_the_middle',
    'KITCHEN_SCENE2_stack_the_middle_black_bowl_on_the_back_black_bowl',
    'KITCHEN_SCENE3_put_the_frying_pan_on_the_stove',
    'KITCHEN_SCENE3_put_the_moka_pot_on_the_stove',
    'KITCHEN_SCENE3_turn_on_the_stove',
    'KITCHEN_SCENE3_turn_on_the_stove_and_put_the_frying_pan_on_it',
    'KITCHEN_SCENE4_close_the_bottom_drawer_of_the_cabinet',
    'KITCHEN_SCENE4_close_the_bottom_drawer_of_the_cabinet_and_open_the_top_drawer',
    'KITCHEN_SCENE4_put_the_black_bowl_in_the_bottom_drawer_of_the_cabinet',
    'KITCHEN_SCENE4_put_the_black_bowl_on_top_of_the_cabinet',
    'KITCHEN_SCENE4_put_the_wine_bottle_in_the_bottom_drawer_of_the_cabinet',
    'KITCHEN_SCENE4_put_the_wine_bottle_on_the_wine_rack',
    'KITCHEN_SCENE5_close_the_top_drawer_of_the_cabinet',
    'KITCHEN_SCENE5_put_the_black_bowl_in_the_top_drawer_of_the_cabinet',
    'KITCHEN_SCENE5_put_the_black_bowl_on_the_plate',
    'KITCHEN_SCENE5_put_the_black_bowl_on_top_of_the_cabinet',
    'KITCHEN_SCENE5_put_the_ketchup_in_the_top_drawer_of_the_cabinet',
    'KITCHEN_SCENE6_close_the_microwave',
    'KITCHEN_SCENE6_put_the_yellow_and_white_mug_to_the_front_of_the_white_mug',
    'KITCHEN_SCENE7_open_the_microwave',
    'KITCHEN_SCENE7_put_the_white_bowl_on_the_plate',
    'KITCHEN_SCENE7_put_the_white_bowl_to_the_right_of_the_plate',
    'KITCHEN_SCENE8_put_the_right_moka_pot_on_the_stove',
    'KITCHEN_SCENE8_turn_off_the_stove',
    'KITCHEN_SCENE9_put_the_frying_pan_on_the_cabinet_shelf',
    'KITCHEN_SCENE9_put_the_frying_pan_on_top_of_the_cabinet',
    'KITCHEN_SCENE9_put_the_frying_pan_under_the_cabinet_shelf',
    'KITCHEN_SCENE9_put_the_white_bowl_on_top_of_the_cabinet',
    'KITCHEN_SCENE9_turn_on_the_stove',
    'KITCHEN_SCENE9_turn_on_the_stove_and_put_the_frying_pan_on_it',
    'LIVING_ROOM_SCENE1_pick_up_the_alphabet_soup_and_put_it_in_the_basket',
    'LIVING_ROOM_SCENE1_pick_up_the_cream_cheese_box_and_put_it_in_the_basket',
    'LIVING_ROOM_SCENE1_pick_up_the_ketchup_and_put_it_in_the_basket',
    'LIVING_ROOM_SCENE1_pick_up_the_tomato_sauce_and_put_it_in_the_basket',
    'LIVING_ROOM_SCENE2_pick_up_the_alphabet_soup_and_put_it_in_the_basket',
    'LIVING_ROOM_SCENE2_pick_up_the_butter_and_put_it_in_the_basket',
    'LIVING_ROOM_SCENE2_pick_up_the_milk_and_put_it_in_the_basket',
    'LIVING_ROOM_SCENE2_pick_up_the_orange_juice_and_put_it_in_the_basket',
    'LIVING_ROOM_SCENE2_pick_up_the_tomato_sauce_and_put_it_in_the_basket',
    'LIVING_ROOM_SCENE3_pick_up_the_alphabet_soup_and_put_it_in_the_tray',
    'LIVING_ROOM_SCENE3_pick_up_the_butter_and_put_it_in_the_tray',
    'LIVING_ROOM_SCENE3_pick_up_the_cream_cheese_and_put_it_in_the_tray',
    'LIVING_ROOM_SCENE3_pick_up_the_ketchup_and_put_it_in_the_tray',
    'LIVING_ROOM_SCENE3_pick_up_the_tomato_sauce_and_put_it_in_the_tray',
    'LIVING_ROOM_SCENE4_pick_up_the_black_bowl_on_the_left_and_put_it_in_the_tray',
    'LIVING_ROOM_SCENE4_pick_up_the_chocolate_pudding_and_put_it_in_the_tray',
    'LIVING_ROOM_SCENE4_pick_up_the_salad_dressing_and_put_it_in_the_tray',
    'LIVING_ROOM_SCENE4_stack_the_left_bowl_on_the_right_bowl_and_place_them_in_the_tray',
    'LIVING_ROOM_SCENE4_stack_the_right_bowl_on_the_left_bowl_and_place_them_in_the_tray',
    'LIVING_ROOM_SCENE5_put_the_red_mug_on_the_left_plate',
    'LIVING_ROOM_SCENE5_put_the_red_mug_on_the_right_plate',
    'LIVING_ROOM_SCENE5_put_the_white_mug_on_the_left_plate',
    'LIVING_ROOM_SCENE5_put_the_yellow_and_white_mug_on_the_right_plate',
    'LIVING_ROOM_SCENE6_put_the_chocolate_pudding_to_the_left_of_the_plate',
    'LIVING_ROOM_SCENE6_put_the_chocolate_pudding_to_the_right_of_the_plate',
    'LIVING_ROOM_SCENE6_put_the_red_mug_on_the_plate',
    'LIVING_ROOM_SCENE6_put_the_white_mug_on_the_plate',
    'STUDY_SCENE1_pick_up_the_book_and_place_it_in_the_front_compartment_of_the_caddy',
    'STUDY_SCENE1_pick_up_the_book_and_place_it_in_the_left_compartment_of_the_caddy',
    'STUDY_SCENE1_pick_up_the_book_and_place_it_in_the_right_compartment_of_the_caddy',
    'STUDY_SCENE1_pick_up_the_yellow_and_white_mug_and_place_it_to_the_right_of_the_caddy',
    'STUDY_SCENE2_pick_up_the_book_and_place_it_in_the_back_compartment_of_the_caddy',
    'STUDY_SCENE2_pick_up_the_book_and_place_it_in_the_front_compartment_of_the_caddy',
    'STUDY_SCENE2_pick_up_the_book_and_place_it_in_the_left_compartment_of_the_caddy',
    'STUDY_SCENE2_pick_up_the_book_and_place_it_in_the_right_compartment_of_the_caddy',
    'STUDY_SCENE3_pick_up_the_book_and_place_it_in_the_front_compartment_of_the_caddy',
    'STUDY_SCENE3_pick_up_the_book_and_place_it_in_the_left_compartment_of_the_caddy',
    'STUDY_SCENE3_pick_up_the_book_and_place_it_in_the_right_compartment_of_the_caddy',
    'STUDY_SCENE3_pick_up_the_red_mug_and_place_it_to_the_right_of_the_caddy',
    'STUDY_SCENE3_pick_up_the_white_mug_and_place_it_to_the_right_of_the_caddy',
    'STUDY_SCENE4_pick_up_the_book_in_the_middle_and_place_it_on_the_cabinet_shelf',
    'STUDY_SCENE4_pick_up_the_book_on_the_left_and_place_it_on_top_of_the_shelf',
    'STUDY_SCENE4_pick_up_the_book_on_the_right_and_place_it_on_the_cabinet_shelf',
    'STUDY_SCENE4_pick_up_the_book_on_the_right_and_place_it_under_the_cabinet_shelf',
  ],
}

/** 与官方 `grab_language_from_filename` 相同。 */
export function languageFromTaskId(taskId: string): string {
  const x = taskId.endsWith('.bddl') ? taskId : `${taskId}.bddl`
  const first = x[0]
  const titled = first !== undefined && first === first.toUpperCase() && first !== first.toLowerCase()
  const language = titled
    ? x.slice(x.indexOf('SCENE') + (x.includes('SCENE10') ? 8 : 7)).split('_').join(' ')
    : x.split('_').join(' ')
  const end = language.indexOf('.bddl')
  return end >= 0 ? language.slice(0, end) : language
}

export function officialTaskSpec(suite: OfficialSuiteId, taskId: string, taskIndex: number): BenchmarkTaskSpec {
  return assertBenchmarkTaskSpec({
    benchId: suite,
    benchRevision: OFFICIAL_SOURCE.revision,
    taskId,
    languageInstruction: languageFromTaskId(taskId),
    sceneId: `${suite}/${taskId}`,
    source: { repository: OFFICIAL_SOURCE.repository, revision: OFFICIAL_SOURCE.revision, taskRef: `${suite}:${taskIndex}:${taskId}` },
    episode: { seed: 0, initialStateRef: '0', horizonSteps: 1000, controlFrequencyHz: 20 },
    observation: { modalities: ['rgb', 'proprioception'], fields: ['agentview_image', 'robot0_eef_pos', 'robot0_eef_quat', 'robot0_gripper_qpos', 'robot0_joint_pos', 'objects.*_pos', 'objects.*_quat', 'objects.*_to_robot0_eef_pos', 'objects.*_to_robot0_eef_quat'], coordinateSystem: 'official-env' },
    action: {
      kind: 'controller',
      dimensions: 7,
      units: ['normalized world dx [-1,1] -> ±0.05 m', 'normalized world dy [-1,1] -> ±0.05 m', 'normalized world dz [-1,1] -> ±0.05 m', 'normalized world droll [-1,1] -> ±0.5 rad', 'normalized world dpitch [-1,1] -> ±0.5 rad', 'normalized world dyaw [-1,1] -> ±0.5 rad', 'gripper open_close [-1,1]'],
      lower: [-1, -1, -1, -1, -1, -1, -1],
      upper: [1, 1, 1, 1, 1, 1, 1],
      controlFrequencyHz: 20,
      coordinateFrame: 'world-frame Cartesian position delta and world-frame axis-angle delta',
      axisNames: ['controller_dx', 'controller_dy', 'controller_dz', 'controller_droll', 'controller_dpitch', 'controller_dyaw', 'gripper_open_close'],
    },
    robot: {
      entityId: 'official-robot',
      modelVersion: 'libero-panda-osc-pose',
      morphology: 'arm',
      joints: ['robot0_joint1', 'robot0_joint2', 'robot0_joint3', 'robot0_joint4', 'robot0_joint5', 'robot0_joint6', 'robot0_joint7'],
      controlledJointNames: ['robot0_joint1', 'robot0_joint2', 'robot0_joint3', 'robot0_joint4', 'robot0_joint5', 'robot0_joint6', 'robot0_joint7'],
      endEffector: 'gripper',
    },
    evaluator: { source: 'official-env.check_success', successRule: 'env.check_success()', timeoutRule: 'horizon reached' },
  })
}

export function catalogTasks(suite: string = DEFAULT_SUITE): BenchmarkTaskSpec[] {
  if (!OFFICIAL_SUITES.includes(suite as OfficialSuiteId)) throw new Error('BENCHMARK_SUITE_NOT_FOUND')
  return OFFICIAL_TASK_IDS[suite as OfficialSuiteId].map((taskId, index) => officialTaskSpec(suite as OfficialSuiteId, taskId, index))
}

export function lookupTask(suite: string, taskId?: string, taskIndex?: number): BenchmarkTaskSpec {
  const tasks = catalogTasks(suite)
  if (typeof taskId === 'string' && taskId) {
    const found = tasks.find(task => task.taskId === taskId)
    if (!found) throw new Error('BENCHMARK_TASK_NOT_FOUND')
    return found
  }
  const index = taskIndex ?? 0
  const task = tasks[index]
  if (!task) throw new Error('BENCHMARK_TASK_INDEX_OUT_OF_RANGE')
  return task
}
