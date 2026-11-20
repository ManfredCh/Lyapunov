"""Prepare detached input artifacts for the native robotics acceptance batch."""
import argparse
import json
from pathlib import Path
import shutil

import mujoco
import numpy as np
from PIL import Image


def save(path, value):
    path.write_text(json.dumps(value, indent=2, default=lambda item: item.tolist()) + '\n')


def capture(out):
    # A centered colored sphere lets us extract matching observed pixels from RGB.
    xyz = np.array([-0.24, 0.0, 0.1])
    axes = np.diag([1., -1., -1.])
    positions = [np.array([-0.20, -0.08, 0.7]), np.array([0.03, 0.13, 0.7])]
    cams = ''.join(f'<camera name="view{i}" pos="{" ".join(map(str,pos))}" xyaxes="1 0 0 0 1 0" fovy="40"/>' for i, pos in enumerate(positions))
    xml = f'<mujoco><worldbody>{cams}<light pos="0 0 1"/><geom type="sphere" pos="-0.24 0 0.1" size="0.012" rgba="1 0 0 1"/></worldbody></mujoco>'
    (out / 'rgb-scene.xml').write_text(xml)
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    width, height = 320, 240
    focal = height / (2 * np.tan(np.deg2rad(20)))
    k = [[focal, 0, (width-1)/2], [0, focal, (height-1)/2], [0, 0, 1]]
    views = []
    with mujoco.Renderer(model, height, width) as renderer:
        for index, pos in enumerate(positions):
            renderer.update_scene(data, camera=f'view{index}')
            rgb = renderer.render().copy()
            Image.fromarray(rgb).save(out / f'camera-{index}.png')
            red = (rgb[:, :, 0] > 80) & (rgb[:, :, 0].astype(float) - np.max(rgb[:, :, 1:], axis=2) > 45)
            Image.fromarray((red * 255).astype('uint8')).save(out / f'mask-{index}.png')
            rows, cols = np.where(red)
            assert len(rows) > 30
            t = np.eye(4)
            t[:3, :3] = axes
            t[:3, 3] = pos
            views.append({'intrinsics': k, 'worldFromCamera': t, 'pixels': [[cols.mean(), rows.mean()]]})
    localization = {'mode': 'triangulate', 'views': views}
    save(out / 'rgb.json', localization)
    save(out / 'camera-request.json', {'camera': 'view0', 'width': width, 'height': height})
    save(out / 'plane.json', {'mode': 'plane-mask', 'planeZM': float(xyz[2]), 'camera': views[0]})
    transfer = {'goal': [0.24, 0, 0.1, 0, 0, 0], 'spheres': [{'center': [0, 0, 0], 'radius': 0.024}],
                'obstacles': [
                    {'name': 'partition', 'center': [0, 0, 0.12], 'halfExtents': [0.05, 0.15, 0.12]},
                    {'name': 'work_surface', 'center': [0, 0, -0.3], 'halfExtents': [0.70, 0.70, 0.30]},
                ],
                'seed': 91}
    save(out / 'vision-plan.json', {'localization': localization, 'transfer': transfer})
    save(out / 'exact-plan.json', {**transfer, 'start': [*xyz, 0, 0, 0]})
    save(out / 'ibvs.json', {'pixels': [[144, 91], [174, 91], [144, 121], [174, 121]], 'goalPixels': [[132, 88], [162, 88], [132, 118], [162, 118]],
                            'depthM': [.6] * 4, 'intrinsics': k, 'eeFromCamera': np.eye(4)})
    return xyz.tolist()


def model_input(out, path, folder):
    shutil.copytree(path.parent, out / folder, dirs_exist_ok=True, ignore=shutil.ignore_patterns('*.png', '*.md'))
    return out / folder / path.name


def ik_input(xml, out):
    model = mujoco.MjModel.from_xml_path(str(xml))
    data = mujoco.MjData(model)
    print('YAM', model.njnt, model.nu, [model.site(n).name for n in range(model.nsite)], flush=True)
    q = np.array([0.18, 0.64, 0.4, 0.2, 0.35, -0.12])
    data.qpos[:6] = q
    mujoco.mj_kinematics(model, data)
    site = 'grasp_site'
    sid = model.site(site).id
    target = np.eye(4)
    target[:3, :3] = data.site_xmat[sid].reshape(3, 3)
    target[:3, 3] = data.site_xpos[sid]
    save(out / 'yam-ik.json', {'tcpSite': site, 'start': q * .92, 'target': target})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('out', type=Path)
    parser.add_argument('--so101', type=Path, required=True)
    parser.add_argument('--menagerie', type=Path, required=True)
    parser.add_argument('--playground-so101', type=Path)
    args = parser.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=False)
    truth = capture(out)
    (out / 'asset.xml').write_text('''<mujoco model="sorting cube"><compiler angle="radian"/>
<worldbody><body name="cube"><geom name="cube_visual" group="2" type="box" size=".024 .021 .02" rgba=".8 .18 .08 1" contype="0" conaffinity="0" mass="0"/>
<geom name="cube_collision" group="3" type="box" size=".024 .021 .02" rgba=".25 .6 .9 .6" mass=".12"/></body></worldbody></mujoco>
''')
    (out / 'rl-task.py').write_text('def step(self, state):\n    return state.cpu()\n')
    helper_root = Path(__file__).resolve().parents[2] / 'packages/robot-workflows/python/agy'
    (out / 'make-prop.py').write_text(f"""import sys
sys.path.insert(0, {str(helper_root)!r})
from blender_mesh_utils import clear_scene, swept_tube, assign_pbr_material
clear_scene()
handle = swept_tube('sorter_handle', [(-.05, 0, .015), (-.05, 0, .06), (.05, 0, .06), (.05, 0, .015)], .008)
assign_pbr_material(handle, base_color_srgb=(207, 75, 45), roughness=.4)
""")
    save(out / 'showcase.json', {'panelSize': 192})
    poses = np.array([[x, y, z] for x in (-.1, 0, .1) for y in (-.11, .11) for z in (.05, .12)])
    matrix = np.array([[250, 2, 3, 150], [4, -240, 2, 120], [.03, -.06, .15, 1]])
    projected = np.column_stack((poses, np.ones(len(poses)))) @ matrix.T
    save(out / 'calibration.json', {'worldPoints': poses, 'pixels': projected[:, :2] / projected[:, 2:], 'regularization': 0})
    save(out / 'schedule.json', {'taskId': 'so101-sort', 'seed': 42, 'casesPerTier': 4})
    so101 = model_input(out, args.so101, 'so101')
    if args.playground_so101:
        model_input(out, args.playground_so101, 'playground-so101')
    model = mujoco.MjModel.from_xml_path(str(so101))
    joints = [model.joint(i).name for i in range(model.njnt)][:5]
    identity = np.eye(4)
    identity[2, 3] = .02
    save(out / 'so101-plan.json', {'tcpSite': 'gripperframe', 'jointNames': joints, 'start': [0]*5,
                                  'goal': [.2, .05, -.10, .12, .10], 'seed': 9,
                                  'payload': {'eeFromObject': identity, 'spheres': [{'center': [0, 0, 0], 'radius': .012}]}})
    yampath = args.menagerie / 'i2rt_yam' / 'yam_linear_4310.xml'
    yam = model_input(out, yampath, 'yam')
    ik_input(yam, out)
    fr3path = args.menagerie / 'franka_fr3_duo' / 'fr3_duo.xml'
    fr3 = model_input(out, fr3path, 'fr3-duo')
    fr3_model = mujoco.MjModel.from_xml_path(str(fr3))
    names = [fr3_model.site(i).name for i in range(fr3_model.nsite)]
    def arm(side):
        first = [0., 0., 0., -1.5, 0., 1.5, 0.]
        last = first.copy()
        last[0] += 0.08 if side == 'left' else -0.08
        return {'rootBody': f'{side}_fr3v2_link0', 'jointNames': [f'{side}_fr3v2_joint{index}' for index in range(1, 8)],
                'positions': [first, last]}
    save(out / 'fr3-check.json', {'left': arm('left'), 'right': arm('right')})
    save(out / 'truth.json', {'targetPositionM': truth, 'fr3': {'joints': fr3_model.njnt, 'actuators': fr3_model.nu, 'sites': names}})
    shutil.copyfile(args.menagerie / 'supply.json', out / 'menagerie-supply.json')


if __name__ == '__main__':
    main()
