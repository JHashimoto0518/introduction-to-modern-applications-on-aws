import { RemovalPolicy, Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';

export class MonolithicStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // vpc
    const vpc = new ec2.Vpc(this, 'BookStoreVpc', {
      vpcName: 'bookstore-vpc',
      ipAddresses: ec2.IpAddresses.cidr('172.16.0.0/16'),
      natGateways: 1,
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
        }
      ],
    });

    // add private endpoints for session manager
    vpc.addInterfaceEndpoint('SsmEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
    });
    vpc.addInterfaceEndpoint('SsmMessagesEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
    });
    vpc.addInterfaceEndpoint('Ec2MessagesEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
    });

    //
    // security group
    //
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      allowAllOutbound: true,
      description: 'security group for alb'
    })
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'allow http traffic from anywhere')

    const ec2Sg = new ec2.SecurityGroup(this, 'AppEc2Sg', {
      vpc,
      allowAllOutbound: true,
      description: 'security group for application servers'
    })
    ec2Sg.connections.allowFrom(albSg, ec2.Port.tcp(80), 'allow http traffic from alb')

    //
    // role
    //
    const ec2Role = new iam.Role(this, 'AppRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'AmazonSSMManagedInstanceCore'
        ),
      ],
      description: 'role for application servers',
    });

    //
    // application server
    //
    // NOTE: The cloud-init output log file captures console output by user data. See: /var/log/cloud-init-output.log
    const userData = ec2.UserData.forLinux({
      shebang: '#!/bin/bash',
    })
    // setup nginx  See: https://aws.amazon.com/jp/amazon-linux-2/faqs/#Amazon_Linux_Extras
    userData.addCommands(
      'amazon-linux-extras install -y nginx1',
      'systemctl start nginx',
      'systemctl enable nginx',
    )
    //setup asp.net core runtime
    userData.addCommands(
      'rpm -Uvh https://packages.microsoft.com/config/rhel/7/packages-microsoft-prod.rpm',
      'yum install -y aspnetcore-runtime-7.0'
    )

    const launchTmpl = new ec2.LaunchTemplate(this, 'AppLaunchTmpl', {
      launchTemplateName: 'app-launch-tmpl',
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2({
        cachedInContext: true,
      }),
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: autoscaling.BlockDeviceVolume.ebs(8, {
            volumeType: autoscaling.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
      securityGroup: ec2Sg,
      role: ec2Role,
      userData,
    });

    const asGrpWeb = new autoscaling.AutoScalingGroup(this, 'AppAutoScalingGrp', {
      launchTemplate: launchTmpl,
      vpc,
      vpcSubnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      }),
      desiredCapacity: 1,
      minCapacity: 1,
      maxCapacity: 3,
    })
    asGrpWeb.scaleOnCpuUtilization('Cpu50Percent', {
      targetUtilizationPercent: 50
    });

    //
    // alb
    //
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      internetFacing: true,
      vpc,
      vpcSubnets: {
        subnets: vpc.publicSubnets
      },
      securityGroup: albSg
    })

    const listener = alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP
    })
    listener.addTargets('AppTarget', {
      targets: [asGrpWeb],
      port: 80
    })

    // output test command
    new CfnOutput(this, 'TestCommand', {
      value: `curl -I http://${alb.loadBalancerDnsName}`
    })

    //
    // rds
    //
    const engine = rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0_31 });
    const paramGrp = new rds.ParameterGroup(this, 'BookStoreParamGrp', {
      engine,
      description: 'for bookstore'
    })
    const optGrp = new rds.OptionGroup(this, 'BookStoreOptGrp', {
      engine,
      configurations: [],
      description: 'for bookstore'
    })

    const dbInstance = new rds.DatabaseInstance(this, 'BookStoreDbInstance', {
      engine,
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.SMALL),
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      databaseName: 'bookstore',
      parameterGroup: paramGrp,
      optionGroup: optGrp,
      multiAz: true,
      deleteAutomatedBackups: true,
      removalPolicy: RemovalPolicy.DESTROY    // to avoid OptionGroup deletion error, do not leave any snapshots
    });
    dbInstance.connections.allowDefaultPortFrom(ec2Sg);
  }
}
