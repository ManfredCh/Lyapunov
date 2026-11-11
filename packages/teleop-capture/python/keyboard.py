"""将工作台单次键输入交给固定版本 Isaac Capture 重定向。"""
import json
import sys

from isaaccapture.deviceio_trackers import EvdevKeyCode
from isaaccapture.schema import KeyAction, KeyboardOutput, KeyEvent
from isaaccapture.retargeting_engine.deviceio_source_nodes import KeyboardSource
from isaaccapture.retargeting_engine.interface import TensorGroup
from isaaccapture.retargeting_engine.interface.base_retargeter import _make_output_group
from isaaccapture.retargeting_engine.interface.execution_events import ExecutionEvents
from isaaccapture.retargeting_engine.interface.retargeter_core_types import ComputeContext
from isaaccapture.retargeters.gripper_retargeter import KeyboardGripperRetargeter
from isaaccapture.retargeters.keyboard_se3_retargeter import (
    KeyboardToSe3RelRetargeter, KeyboardToSe3RelRetargeterConfig,
)


def keyboard_frame(keys):
    source = KeyboardSource(name='keyboard')
    group = TensorGroup(source.input_spec()['deviceio_keyboard'])
    group[0] = KeyboardOutput(keys, [KeyEvent(0, key, KeyAction.PRESS) for key in keys])
    outputs = {name: _make_output_group(spec) for name, spec in source.output_spec().items()}
    source.compute({'deviceio_keyboard': group}, outputs)
    return outputs


def retarget(request):
    key = request['key']
    if key not in ('KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'KeyZ', 'KeyX', 'KeyT', 'KeyG', 'KeyC', 'KeyV', 'KeyK'):
        raise ValueError('CAPTURE_KEY_UNSUPPORTED')
    frame = keyboard_frame([getattr(EvdevKeyCode, key)])
    arm = KeyboardToSe3RelRetargeter(KeyboardToSe3RelRetargeterConfig(pos_sensitivity=.01, rot_sensitivity=.05), name='arm')
    delta = {'ee_delta': _make_output_group(arm.output_spec()['ee_delta'])}
    arm.compute({'keyboard_held': frame['keyboard_held']}, delta)
    grip = KeyboardGripperRetargeter(name='gripper')
    command = {'gripper_command': _make_output_group(grip.output_spec()['gripper_command'])}
    context = ComputeContext(execution_events=ExecutionEvents())
    if request['gripperClosed']:
        previous = keyboard_frame([EvdevKeyCode.KeyK])
        grip.compute({'keyboard_pressed': previous['keyboard_pressed']}, command, context)
    grip.compute({'keyboard_pressed': frame['keyboard_pressed']}, command, context)
    return {'delta': delta['ee_delta'][0].tolist(), 'gripperClosed': command['gripper_command'][0] < 0}


if __name__ == '__main__':
    print(json.dumps(retarget(json.load(sys.stdin))))
